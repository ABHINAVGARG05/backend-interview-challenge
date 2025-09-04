import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import {
  Task,
  SyncQueueItem,
  SyncResult,
  BatchSyncRequest,
  BatchSyncResponse,
} from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';

const SYNC_BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE || '10', 10);
const MAX_RETRY_COUNT = 3;

const OP_PRIORITY: Record<'create' | 'update' | 'delete', number> = {
  create: 1,
  update: 2,
  delete: 3,
};

export class SyncService {
  private apiUrl: string;

  constructor(
    private db: Database,
    private taskService?: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api',
  ) {
    this.apiUrl = apiUrl;
    this.initializeDLQ();
  }

  /**
   * Ensure DLQ table exists
   */
  private async initializeDLQ(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS dead_letter_queue (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        data TEXT,
        error_message TEXT,
        failed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  /**
   * Main sync orchestration method
   */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      synced_items: 0,
      failed_items: 0,
      errors: [],
    };

    try {
      const rawItems = await this.db.all<{
        id: string;
        task_id: string;
        operation: string;
        data: string;
        created_at: string;
        retry_count: number;
        error_message: string | null;
      }>(`SELECT * FROM sync_queue ORDER BY created_at ASC`);

      const items: SyncQueueItem[] = rawItems.map((row) => {
        return {
          id: row.id,
          task_id: row.task_id,
          operation: row.operation as 'create' | 'update' | 'delete',
          data: JSON.parse(row.data),
          created_at: new Date(row.created_at),
          retry_count: row.retry_count,
          error_message: row.error_message || undefined,
        };
      });

      // Re-sort to guarantee per-task chronological order and op-priority on same-timestamp ties
      const sorted = [...items].sort((a, b) => {
        if (a.task_id !== b.task_id) return a.task_id < b.task_id ? -1 : 1;
        const ta = new Date(a.created_at).getTime();
        const tb = new Date(b.created_at).getTime();
        if (ta !== tb) return ta - tb;
        return OP_PRIORITY[a.operation] - OP_PRIORITY[b.operation];
      });

      for (let i = 0; i < sorted.length; i += SYNC_BATCH_SIZE) {
        const batch = sorted.slice(i, i + SYNC_BATCH_SIZE);

        const taskIds = Array.from(new Set(batch.map((x) => x.task_id)));
        await this.markTasksInProgress(taskIds);

        try {
          const response = await this.processBatch(batch);

          for (const res of response.processed_items) {
            if (res.status === 'success') {
              await this.updateSyncStatus(
                res.client_id,
                'synced',
                res.resolved_data,
              );
              result.synced_items++;
            } else if (res.status === 'conflict' && res.resolved_data) {
              // Conflict: resolve using LWW + op-priority tie-break
              const localTask = await this.taskService?.getTask(res.client_id);
              if (localTask) {
                const resolved = await this.resolveConflict(
                  localTask,
                  res.resolved_data,
                );
                await this.taskService?.updateTask(res.client_id, resolved);
                await this.updateSyncStatus(res.client_id, 'synced', resolved);
                result.synced_items++;
              } else {
                // If we don't have the local, treat as failure for accounting
                result.failed_items++;
                result.errors.push({
                  task_id: res.client_id,
                  operation: 'unknown',
                  error: 'Conflict: local task missing',
                  timestamp: new Date(),
                });
                await this.db.run(
                  `UPDATE tasks SET sync_status = 'error' WHERE id = ?`,
                  [res.client_id],
                );
                result.success = false;
              }
            } else {
              // Explicit error from server item
              result.failed_items++;
              result.errors.push({
                task_id: res.client_id,
                operation: 'unknown',
                error: res.error || 'Unknown error',
                timestamp: new Date(),
              });
              await this.db.run(
                `UPDATE tasks SET sync_status = 'error' WHERE id = ?`,
                [res.client_id],
              );
              result.success = false;
            }
          }
        } catch (err: unknown) {
          const errorMessage =
            err instanceof Error ? err.message : 'Unknown error';
          for (const item of batch) {
            await this.handleSyncError(
              item,
              err instanceof Error ? err : new Error(errorMessage),
            );
            result.failed_items++;
            result.errors.push({
              task_id: item.task_id,
              operation: item.operation,
              error: errorMessage,
              timestamp: new Date(),
            });
          }
          result.success = false;
        }
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      result.success = false;
      result.errors.push({
        task_id: 'N/A',
        operation: 'sync',
        error: errorMessage,
        timestamp: new Date(),
      });
    }

    return result;
  }

  /**
   * Add operation to sync queue
   */
  async addToSyncQueue(
    taskId: string,
    operation: 'create' | 'update' | 'delete',
    data: Partial<Task>,
  ): Promise<void> {
    const item: SyncQueueItem = {
      id: uuidv4(),
      task_id: taskId,
      operation,
      data,
      created_at: new Date(),
      retry_count: 0,
    };

    await this.db.run(
      `INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        item.task_id,
        item.operation,
        JSON.stringify(item.data),
        item.created_at.toISOString(),
        item.retry_count,
      ],
    );
  }

  /**
   * Process a batch of sync items
   */
  private async processBatch(
    items: SyncQueueItem[],
  ): Promise<BatchSyncResponse> {
    const checksum = this.calculateChecksum(items);

    const request: BatchSyncRequest & { checksum: string } = {
      items: items.map((item) => ({
        ...item,
        data: item.data,
      })),
      client_timestamp: new Date(),
      checksum,
    };

    if (!(await this.checkConnectivity())) {
      throw new Error('Server not reachable');
    }

    const response = await axios.post<BatchSyncResponse>(
      `${this.apiUrl}/sync/batch`,
      request,
    );

    return response.data;
  }

  /**
   * Conflict resolution:
   */
  private async resolveConflict(
    localTask: Task,
    serverTask: Task,
  ): Promise<Task> {
    const localUpdated = new Date(localTask.updated_at).getTime();
    const serverUpdated = new Date(serverTask.updated_at).getTime();

    if (localUpdated > serverUpdated) return localTask;
    if (serverUpdated > localUpdated) return serverTask;

    // Tie → compare op types by priority
    const localOp = this.inferOperationType(localTask);
    const serverOp = this.inferOperationType(serverTask);

    return OP_PRIORITY[localOp] >= OP_PRIORITY[serverOp]
      ? localTask
      : serverTask;
  }

  /**
   * Update sync status (supports new required states)
   */
  private async updateSyncStatus(
    taskId: string,
    status: 'synced' | 'error' | 'failed' | 'in-progress',
    serverData?: Partial<Task>,
  ): Promise<void> {
    await this.db.run(
      `UPDATE tasks
       SET sync_status = ?, 
           server_id = COALESCE(?, server_id),
           last_synced_at = CASE WHEN ? = 'synced' THEN CURRENT_TIMESTAMP ELSE last_synced_at END
       WHERE id = ?`,
      [status, serverData?.server_id || null, status, taskId],
    );

    // Remove from queue only on terminal success/failure
    if (status === 'synced' || status === 'failed') {
      await this.db.run(`DELETE FROM sync_queue WHERE task_id = ?`, [taskId]);
    }
  }

  /**
   * Handle sync errors & DLQ
   */
  private async handleSyncError(
    item: SyncQueueItem,
    error: Error,
  ): Promise<void> {
    const retryRow = await this.db.get<{ retry_count: number }>(
      `SELECT retry_count FROM sync_queue WHERE id = ?`,
      [item.id],
      true
    );
    const currentRetry = retryRow
      ? Number(retryRow.retry_count)
      : item.retry_count;
    const retryCount = currentRetry + 1;

    if (retryCount >= MAX_RETRY_COUNT) {
      // move to DLQ
      await this.db.run(
        `INSERT INTO dead_letter_queue (id, task_id, operation, data, error_message)
         VALUES (?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          item.task_id,
          item.operation,
          JSON.stringify(item.data),
          error.message,
        ],
      );

      await this.db.run(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);

      await this.updateSyncStatus(item.task_id, 'failed');
    } else {
      await this.db.run(
        `UPDATE sync_queue
         SET retry_count = ?, error_message = ?
         WHERE id = ?`,
        [retryCount, error.message, item.id],
      );
      await this.updateSyncStatus(item.task_id, 'error');
    }
  }

  /**
   * Connectivity health check
   */
  async checkConnectivity(): Promise<boolean> {
    try {
      await axios.get(`${this.apiUrl}/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Calculate checksum required by challenge for each batch
   */
  private calculateChecksum(items: SyncQueueItem[]): string {
    const data = items
      .map(
        (i) =>
          `${i.task_id}:${i.operation}:${new Date(i.created_at).toISOString()}`,
      )
      .join('|');
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const chr = data.charCodeAt(i);
      hash = (hash << 5) - hash + chr;
      hash |= 0;
    }
    return hash.toString();
  }

  /**
   * Mark tasks as 'in-progress' before sending a batch
   */
  private async markTasksInProgress(taskIds: string[]): Promise<void> {
    if (!taskIds.length) return;
    const placeholders = taskIds.map(() => '?').join(',');
    await this.db.run(
      `UPDATE tasks
       SET sync_status = 'in-progress'
       WHERE id IN (${placeholders})`,
      taskIds,
    );
  }

  /**
   * Infer an operation type from a task snapshot (for conflict tie-breaks)
   */
  private inferOperationType(task: Task): 'create' | 'update' | 'delete' {
    if (task.is_deleted) return 'delete';
    const created = new Date(task.created_at).getTime();
    const updated = new Date(task.updated_at).getTime();
    const taskWithVersion = task as Task & { version?: number };
    if (
      (taskWithVersion.version && taskWithVersion.version <= 1) ||
      created === updated
    )
      return 'create';
    return 'update';
  }
}
