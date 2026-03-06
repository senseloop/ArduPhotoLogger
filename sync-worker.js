// Sync worker for PostgreSQL synchronization
const postgres = require('./postgres');

class SyncWorker {
    constructor(database, options = {}) {
        this.db = database;
        this.isRunning = false;
        this.intervalId = null;
        
        // Configuration with defaults
        this.config = {
            syncIntervalMs: options.syncIntervalMs || 30000, // 30 seconds
            batchSize: options.batchSize || 50,
            maxRetries: options.maxRetries || 5,
            retryBackoffMs: options.retryBackoffMs || 60000, // 1 minute
            cleanupIntervalMs: options.cleanupIntervalMs || 3600000, // 1 hour
            cleanupOlderThanHours: options.cleanupOlderThanHours || 24,
            enabled: options.enabled !== false // Default to enabled
        };

        this.stats = {
            totalSynced: 0,
            totalFailed: 0,
            lastSyncTime: null,
            lastSyncStatus: null,
            consecutiveFailures: 0
        };

        this.lastCleanup = Date.now();
    }

    // Start the sync worker
    async start() {
        if (this.isRunning) {
            console.log('Sync worker is already running');
            return;
        }

        if (!this.config.enabled) {
            console.log('Sync worker is disabled');
            return;
        }

        console.log('Starting sync worker...');

        // Initialize PostgreSQL
        try {
            postgres.initializePostgres();
            const isConnected = await postgres.testConnection();
            
            if (!isConnected) {
                console.error('PostgreSQL connection failed. Sync worker will retry on next interval.');
                this.stats.lastSyncStatus = 'connection_failed';
            } else {
                console.log('PostgreSQL connection established');
            }
        } catch (err) {
            console.error('Failed to initialize PostgreSQL:', err.message);
            this.stats.lastSyncStatus = 'initialization_failed';
        }

        this.isRunning = true;

        // Start periodic sync
        this.intervalId = setInterval(() => {
            this.syncBatch().catch(err => {
                console.error('Sync batch error:', err);
            });
        }, this.config.syncIntervalMs);

        // Do an immediate sync
        this.syncBatch().catch(err => {
            console.error('Initial sync error:', err);
        });

        console.log(`Sync worker started (interval: ${this.config.syncIntervalMs}ms)`);
        console.log(`Sync configuration: batch=${this.config.batchSize}, maxRetries=${this.config.maxRetries}, cleanup=${this.config.cleanupOlderThanHours}h`);
    }

    // Stop the sync worker
    async stop() {
        if (!this.isRunning) {
            console.log('Sync worker is not running');
            return;
        }

        console.log('Stopping sync worker...');
        this.isRunning = false;

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        await postgres.closePool();
        console.log('Sync worker stopped');
    }

    // Sync a batch of unsynced events
    async syncBatch() {
        if (!this.isRunning) return;

        try {
            // Check PostgreSQL connection
            const isConnected = await postgres.testConnection();
            if (!isConnected) {
                this.stats.consecutiveFailures++;
                this.stats.lastSyncStatus = 'no_connection';
                
                if (this.stats.consecutiveFailures % 10 === 1) {
                    console.log(`PostgreSQL not available (${this.stats.consecutiveFailures} failures). Will retry...`);
                }
                return;
            }

            // Get unsynced events
            const unsyncedEvents = await this.db.getUnsyncedEvents(this.config.batchSize);

            if (unsyncedEvents.length === 0) {
                // No events to sync - perform cleanup if needed
                if (Date.now() - this.lastCleanup > this.config.cleanupIntervalMs) {
                    await this.cleanupOldRecords();
                }
                return;
            }

            // Filter out events that have exceeded max retries
            const eventsToSync = unsyncedEvents.filter(event => {
                const attempts = event.syncAttempts || 0;
                return attempts < this.config.maxRetries;
            });

            if (eventsToSync.length === 0) {
                console.log(`${unsyncedEvents.length} events have exceeded max retry attempts`);
                return;
            }

            console.log(`Syncing ${eventsToSync.length} photo capture events to PostgreSQL...`);

            // Prepare batch data
            const batchData = eventsToSync.map(event => ({
                event: event,
                localDbId: event._id
            }));

            // Attempt batch insert
            const result = await postgres.batchInsertPhotoCaptureEvents(batchData);

            // Mark successfully synced events
            for (let i = 0; i < eventsToSync.length; i++) {
                const event = eventsToSync[i];
                
                if (i < result.success) {
                    // Successfully synced
                    await this.db.markAsSynced(event._id);
                    this.stats.totalSynced++;
                } else {
                    // Failed to sync - increment attempt counter
                    await this.db.markSyncAttempt(event._id);
                    this.stats.totalFailed++;
                }
            }

            this.stats.lastSyncTime = new Date().toISOString();
            this.stats.lastSyncStatus = 'success';
            this.stats.consecutiveFailures = 0;

            console.log(`Sync complete: ${result.success} succeeded, ${result.failed} failed`);

        } catch (err) {
            this.stats.consecutiveFailures++;
            this.stats.lastSyncStatus = 'error';
            console.error('Sync batch failed:', err.message);

            // Mark sync attempts for all unsynced events to prevent immediate retry
            try {
                const unsyncedEvents = await this.db.getUnsyncedEvents(this.config.batchSize);
                for (const event of unsyncedEvents) {
                    await this.db.markSyncAttempt(event._id);
                }
            } catch (markErr) {
                console.error('Failed to mark sync attempts:', markErr.message);
            }
        }
    }

    // Clean up old synced records
    async cleanupOldRecords() {
        try {
            const numRemoved = await this.db.cleanupSyncedRecords(this.config.cleanupOlderThanHours);
            if (numRemoved > 0) {
                console.log(`Cleaned up ${numRemoved} old synced records`);
            }
            this.lastCleanup = Date.now();
        } catch (err) {
            console.error('Cleanup failed:', err.message);
        }
    }

    // Get current stats
    getStats() {
        return {
            ...this.stats,
            isRunning: this.isRunning,
            config: this.config
        };
    }

    // Force a sync now (useful for manual triggering)
    async forceSyncNow() {
        console.log('Forcing immediate sync...');
        await this.syncBatch();
    }
}

module.exports = SyncWorker;
