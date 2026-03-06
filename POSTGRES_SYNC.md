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

Create the database and table on your PostgreSQL server:
```sql
CREATE DATABASE photolog;

CREATE TABLE photolog (
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
    camera_feedback_raw JSONB,
    gimbal_orientation_raw JSONB,
    system_time_raw JSONB,
    local_db_id TEXT UNIQUE,
    hostname TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_photolog_timestamp ON photolog(timestamp);
CREATE INDEX idx_photolog_local_db_id ON photolog(local_db_id);
```

**Note:** The application will NOT create the table automatically. You must create the schema beforehand.

### 3. Configure Connection

Edit `config.conf`:
```ini
[postgres]
host=10.50.0.31
port=5432
database=photolog
table=photolog
user=droneuser
password=your_secure_password
```

**Configuration is now only read from config.conf** - environment variables are no longer used.

### 4. Enable Sync

Edit `config.conf`:
```ini
[sync]
sync_enabled=true
sync_interval_ms=30000
sync_batch_size=50
sync_max_retries=5
sync_cleanup_hours=24
```

### 5. Start the Server
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

[postgres]
host=localhost                 # PostgreSQL server hostname
port=5432                      # PostgreSQL server port
database=photolog              # Database name
table=photolog                 # Table name
user=postgres                  # Database user
password=your_password         # Database password
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

PostgreSQL table structure (you must create this manually):
```sql
CREATE TABLE photolog (
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
1. Check PostgreSQL credentials in config.conf
2. Verify network connectivity: `telnet postgres-host 5432`
3. Check sync status: `GET /api/sync/status`
4. Review logs for connection errors
5. Ensure the table exists in the database

### Events not syncing
- Check `GET /api/sync/pending` to see stuck events
- Force sync: `POST /api/sync/force`
- Check if max retries exceeded (increase `sync_max_retries`)

### Duplicate events
- The `local_db_id` field prevents duplicates
- PostgreSQL will silently skip duplicate inserts

### Table does not exist error
- The application does NOT create tables automatically
- You must create the schema manually using the SQL provided above

## Files Modified

**Modified Files:**
- `postgres.js` - PostgreSQL connection and operations (removed table creation)
- `sync-worker.js` - Background sync worker (removed table creation call)
- `config.js` - Configuration loader (removed environment variable support)
- `database.js` - Added sync tracking fields and methods
- `server.js` - Integrated sync worker
- `api.js` - Added sync status endpoints
- `config.conf` - Added sync configuration and postgres password
- `package.json` - Added `pg` dependency

## Production Recommendations

1. **Configure credentials in config.conf** - all settings are now centralized
2. **Monitor sync status** via the API endpoints
3. **Set appropriate cleanup interval** based on storage capacity
4. **Enable PostgreSQL SSL** for secure connections
5. **Set up PostgreSQL backups** as it's now your primary data store
6. **Consider connection pooling** for high-volume scenarios (already configured)
7. **Create the database schema manually** before starting the application

## Security Notes

- Keep config.conf secure and restrict file permissions
- Use SSL/TLS for PostgreSQL connections in production
- Restrict PostgreSQL access to known IPs
- Use strong passwords for database authentication
- Consider encrypting config.conf or storing it outside the repository
