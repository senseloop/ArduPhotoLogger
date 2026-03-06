# PostgreSQL Sync Implementation Guide

## Overview
The ArduPhotoLogger now includes automatic synchronization to a PostgreSQL server. The local NeDB database acts as a temporary buffer that syncs data when internet connectivity is available.

## Setup Instructions

### 1. Install Dependencies
Already completed:
```bash
npm install pg
```

### 2. Configure PostgreSQL Server

Create the database on your PostgreSQL server:
```sql
CREATE DATABASE arduphotologger;
```

The table will be created automatically on first sync.

### 3. Configure Environment

Option A: Using environment variables (recommended for production):
```bash
export POSTGRES_HOST=your-postgres-server.com
export POSTGRES_PORT=5432
export POSTGRES_DB=arduphotologger
export POSTGRES_USER=postgres
export POSTGRES_PASSWORD=your_secure_password
```

Option B: Edit `config.conf`:
```ini
[postgres]
host=your-postgres-server.com
port=5432
database=arduphotologger
user=postgres
```

**Note:** Never commit passwords to git. Use environment variables for POSTGRES_PASSWORD.

### 4. Start the Server
```bash
npm start
```

The sync worker will:
- Test PostgreSQL connection on startup
- Sync unsynced events every 30 seconds (configurable)
- Retry failed syncs with exponential backoff
- Clean up old synced records after 24 hours

## API Endpoints

### Get Sync Status
```bash
GET /api/sync/status
```

Returns:
```json
{
  "totalSynced": 150,
  "totalFailed": 2,
  "lastSyncTime": "2026-03-05T10:30:00.000Z",
  "lastSyncStatus": "success",
  "consecutiveFailures": 0,
  "isRunning": true,
  "config": {
    "syncIntervalMs": 30000,
    "batchSize": 50,
    "maxRetries": 5,
    "enabled": true
  }
}
```

### Force Immediate Sync
```bash
POST /api/sync/force
```

### Get Pending Events
```bash
GET /api/sync/pending
```

Returns count and details of unsynced events.

## Configuration Options

Edit `config.conf`:

```ini
[sync]
sync_enabled=true              # Enable/disable sync
sync_interval_ms=30000         # Sync every 30 seconds
sync_batch_size=50             # Sync 50 events per batch
sync_max_retries=5             # Max retry attempts per event
sync_cleanup_hours=24          # Delete synced records after 24 hours
```

## How It Works

### On Photo Capture
1. Event is saved to local NeDB with `synced: false`
2. Sync worker picks it up on next interval
3. Event is uploaded to PostgreSQL
4. Local record is marked as `synced: true`
5. After 24 hours, synced records are auto-deleted

### On Connection Loss
- Events accumulate in local database
- Sync worker retries periodically
- When connection returns, events sync automatically
- Failed events retry with backoff (up to 5 attempts)

### Database Schema

PostgreSQL table structure:
```sql
CREATE TABLE photo_captures (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMPTZ NOT NULL,
    time_boot_ms BIGINT,
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    alt_msl REAL,
    alt_rel REAL,
    gimbal_pitch REAL,
    gimbal_roll REAL,
    gimbal_yaw REAL,
    gimbal_yaw_absolute REAL,
    capture_time_iso TIMESTAMPTZ,
    camera_feedback_raw JSONB,      -- Full MAVLink message
    gimbal_orientation_raw JSONB,   -- Full gimbal data
    system_time_raw JSONB,          -- Full system time
    local_db_id TEXT UNIQUE,        -- Prevents duplicates
    hostname TEXT,                  -- Device hostname
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Monitoring

Check sync status in logs:
```
PostgreSQL connection established
Sync worker started (interval: 30000ms)
Syncing 15 photo capture events to PostgreSQL...
Sync complete: 15 succeeded, 0 failed
```

Check via API:
```bash
curl http://localhost:3000/api/sync/status
```

## Troubleshooting

### Sync not working
1. Check PostgreSQL credentials in config.conf or environment variables
2. Verify network connectivity: `telnet postgres-host 5432`
3. Check sync status: `GET /api/sync/status`
4. Review logs for connection errors

### Events not syncing
- Check `GET /api/sync/pending` to see stuck events
- Force sync: `POST /api/sync/force`
- Check if max retries exceeded (increase `sync_max_retries`)

### Duplicate events
- The `local_db_id` field prevents duplicates
- PostgreSQL will silently skip duplicate inserts

## Files Added/Modified

**New Files:**
- `postgres.js` - PostgreSQL connection and operations
- `sync-worker.js` - Background sync worker
- `.env.example` - Environment variable template

**Modified Files:**
- `database.js` - Added sync tracking fields and methods
- `server.js` - Integrated sync worker
- `api.js` - Added sync status endpoints
- `config.conf` - Added sync configuration
- `package.json` - Added `pg` dependency

## Production Recommendations

1. **Use environment variables** for all sensitive credentials
2. **Monitor sync status** via the API endpoints
3. **Set appropriate cleanup interval** based on storage capacity
4. **Enable PostgreSQL SSL** for secure connections
5. **Set up PostgreSQL backups** as it's now your primary data store
6. **Consider connection pooling** for high-volume scenarios (already configured)

## Security Notes

- Never commit `.env` or passwords to version control
- Use SSL/TLS for PostgreSQL connections in production
- Restrict PostgreSQL access to known IPs
- Use strong passwords for database authentication
