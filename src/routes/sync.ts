import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';

export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Trigger manual sync
  router.post('/sync', async (_req: Request, res: Response) => {
    try {
      const online = await syncService.checkConnectivity();
      if (!online) {
        return res.status(503).json({ error: 'No connectivity' });
      }

      const result = await syncService.sync();
      return res.json({ ...result });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return res.status(500).json({ error: 'Sync failed', details: errorMessage });
    }
  });

  // Check sync status
  router.get('/status', async (_req: Request, res: Response) => {
  try {
    const pendingTasks = await taskService.getTasksNeedingSync();
    const lastSynced = await db.get<{ lastSynced: string | null }>(
      'SELECT MAX(last_synced_at) as lastSynced FROM tasks',
      [],
      true
    );

    const online = await syncService.checkConnectivity();

    // Assuming sync queue size is the same as pending tasks needing sync
    const syncQueueSize = pendingTasks.length;

    return res.json({
      pending_sync_count: pendingTasks.length,
      last_sync_timestamp: lastSynced?.lastSynced || null,
      is_online: online,
      sync_queue_size: syncQueueSize,
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res
      .status(500)
      .json({ error: 'Failed to fetch sync status', details: errorMessage });
  }
});


  // Batch sync endpoint (server-side stub)
router.post('/batch', async (req: Request, res: Response) => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items)) {
      return res.status(400).json({ error: 'Invalid items array' });
    }

    const processedItems = await Promise.all(
      items.map(async (item: unknown) => {
        // Type guard for item structure
        if (!item || typeof item !== 'object' || !('data' in item) || !('task_id' in item) || !('created_at' in item)) {
          throw new Error('Invalid item structure');
        }
        
        const typedItem = item as { data: { title: string; description?: string }; task_id: string; created_at: string };

        const serverId = 'srv_' + Math.floor(Math.random() * 1000000); // Example server ID

        const now = new Date().toISOString();
        const resolvedData = {
          id: serverId,
          title: typedItem.data.title,
          description: typedItem.data.description,
          completed: false,
          created_at: typedItem.created_at,
          updated_at: now,
        };

        // Optionally: save resolvedData to DB here

        return {
          client_id: typedItem.task_id,
          server_id: serverId,
          status: 'success',
          resolved_data: resolvedData,
        };
      })
    );

    return res.json({ processed_items: processedItems });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res
      .status(500)
      .json({ error: 'Batch sync failed', details: errorMessage });
  }
});


  // Health check endpoint
  router.get('/health', async (_req: Request, res: Response) => {
    return res.json({ status: 'ok', timestamp: new Date() });
  });

  return router;
}
