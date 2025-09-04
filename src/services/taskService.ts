import { v4 as uuidv4 } from 'uuid';
import { Task } from '../types';
import { Database } from '../db/database';
import { SyncService } from './syncService';

export class TaskService {
  private syncService: SyncService;

  constructor(
    private db: Database,
    syncService?: SyncService,
  ) {
    this.syncService = syncService ?? new SyncService(db);
  }

  /**
   * Create a new task (offline-first: saved locally with pending sync)
   */
  async createTask(taskData: Partial<Task>): Promise<Task> {
    const now = new Date();
    const task: Task = {
      id: uuidv4(),
      title: taskData.title || 'Untitled Task',
      description: taskData.description || '',
      completed: taskData.completed ?? false,
      created_at: now,
      updated_at: now,
      is_deleted: false,
      sync_status: 'pending',
      server_id: undefined,
      last_synced_at: undefined,
    };

    await this.db.run(
      `INSERT INTO tasks (
        id, title, description, completed, created_at, updated_at,
        is_deleted, sync_status, server_id, last_synced_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        task.title,
        task.description,
        task.completed ? 1 : 0,
        task.created_at.toISOString(),
        task.updated_at.toISOString(),
        task.is_deleted ? 1 : 0,
        task.sync_status,
        task.server_id,
        task.last_synced_at,

      ],
    );

    await this.syncService.addToSyncQueue(task.id, 'create', task);

    return task;
  }

  /**
   * Update an existing task (offline-first: mark as pending until synced)
   */
  async updateTask(id: string, updates: Partial<Task>): Promise<Task | null> {
    const existing = await this.getTask(id);
    if (!existing) return null;

    const updated: Task = {
      ...existing,
      ...updates,
      updated_at: new Date(),
      sync_status: 'pending',
    };

    await this.db.run(
      `UPDATE tasks
       SET title = ?, description = ?, completed = ?, updated_at = ?,
           is_deleted = ?, sync_status = ?, version = ?
       WHERE id = ?`,
      [
        updated.title,
        updated.description,
        updated.completed ? 1 : 0,
        updated.updated_at.toISOString(),
        updated.is_deleted ? 1 : 0,
        updated.sync_status,
        updated.id,
      ],
    );

    await this.syncService.addToSyncQueue(updated.id, 'update', updated);

    return updated;
  }

  /**
   * Soft delete a task (offline-first: mark as deleted locally, sync later)
   */
  async deleteTask(id: string): Promise<boolean> {
    const existing = await this.getTask(id);
    if (!existing) return false;

    const updatedAt = new Date();
    //const newVersion = (existing.version ?? 1) + 1;

    await this.db.run(
      `UPDATE tasks
       SET is_deleted = 1, updated_at = ?, sync_status = 'pending', version = ?
       WHERE id = ?`,
      [updatedAt.toISOString(), id],
    );

    await this.syncService.addToSyncQueue(id, 'delete', {
      ...existing,
      is_deleted: true,
      updated_at: updatedAt,
      sync_status: 'pending',

    });

    return true;
  }

  /**
   * Get a single task by ID
   */
  async getTask(id: string): Promise<Task | null> {
    const row = await this.db.get<any>(`SELECT * FROM tasks WHERE id = ?`, [id], true);
    if (!row || row.is_deleted) return null;
    return this.mapRowToTask(row);
  }

  /**
   * Get all non-deleted tasks
   */
  async getAllTasks(): Promise<Task[]> {
    const rows = await this.db.all<any>(`SELECT * FROM tasks WHERE is_deleted = 0`);
    return rows.map((r) => this.mapRowToTask(r));
  }

  /**
   * Get tasks needing sync (pending or failed)
   */
  async getTasksNeedingSync(): Promise<Task[]> {
    const rows = await this.db.all<any>(
      `SELECT * FROM tasks WHERE sync_status IN ('pending', 'error')`
    );
    return rows.map((r) => this.mapRowToTask(r));
  }

  /**
   * Utility: map raw DB row -> Task object
   */

  private mapRowToTask(row: any): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description || '',
      completed: !!row.completed,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      is_deleted: !!row.is_deleted,
      sync_status: row.sync_status as Task['sync_status'],
      server_id: row.server_id || undefined,
      last_synced_at: row.last_synced_at ? new Date(row.last_synced_at) : undefined,
    };
  }
}
