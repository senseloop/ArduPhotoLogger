// PostgreSQL connection and operations module
const { Pool } = require('pg');

let pool = null;

// Initialize PostgreSQL connection pool
function initializePostgres() {
    if (pool) return pool;

    pool = new Pool({
        host: process.env.POSTGRES_HOST || 'localhost',
        port: process.env.POSTGRES_PORT || 5432,
        database: process.env.POSTGRES_DB || 'arduphotologger',
        user: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD,
        // Connection pool settings
        max: 5, // Maximum number of clients in the pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
        console.error('Unexpected PostgreSQL pool error:', err);
    });

    console.log('PostgreSQL connection pool initialized');
    return pool;
}

// Test connection to PostgreSQL
async function testConnection() {
    try {
        const client = await pool.connect();
        await client.query('SELECT NOW()');
        client.release();
        return true;
    } catch (err) {
        console.error('PostgreSQL connection test failed:', err.message);
        return false;
    }
}

// Create the photo_captures table if it doesn't exist
async function createTableIfNotExists() {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS photo_captures (
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
        
        CREATE INDEX IF NOT EXISTS idx_photo_captures_timestamp ON photo_captures(timestamp);
        CREATE INDEX IF NOT EXISTS idx_photo_captures_local_db_id ON photo_captures(local_db_id);
    `;

    try {
        await pool.query(createTableQuery);
        console.log('PostgreSQL table photo_captures ensured');
        return true;
    } catch (err) {
        console.error('Failed to create PostgreSQL table:', err);
        return false;
    }
}

// Insert a photo capture event into PostgreSQL
async function insertPhotoCaptureEvent(event, localDbId) {
    const query = `
        INSERT INTO photo_captures (
            timestamp,
            time_boot_ms,
            lat,
            lng,
            alt_msl,
            alt_rel,
            gimbal_pitch,
            gimbal_roll,
            gimbal_yaw,
            gimbal_yaw_absolute,
            capture_time_iso,
            camera_feedback_raw,
            gimbal_orientation_raw,
            system_time_raw,
            local_db_id,
            hostname
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (local_db_id) DO NOTHING
        RETURNING id
    `;

    const values = [
        event.timestamp,
        event.SystemTime?.timeBootMs,
        event.CameraFeedbackMessage?.lat,
        event.CameraFeedbackMessage?.lng,
        event.CameraFeedbackMessage?.altMsl,
        event.CameraFeedbackMessage?.altRel,
        event.GimbalOrientation?.pitch,
        event.GimbalOrientation?.roll,
        event.GimbalOrientation?.yaw,
        event.GimbalOrientation?.yawAbsolute,
        event.Custom?.dateTimeCaptureISO,
        JSON.stringify(event.CameraFeedbackMessage),
        JSON.stringify(event.GimbalOrientation),
        JSON.stringify(event.SystemTime),
        localDbId,
        event.hostname || null
    ];

    try {
        const result = await pool.query(query, values);
        return result.rowCount > 0 ? result.rows[0].id : null;
    } catch (err) {
        console.error('Failed to insert photo capture event:', err);
        throw err;
    }
}

// Batch insert multiple photo capture events
async function batchInsertPhotoCaptureEvents(events) {
    if (!events || events.length === 0) return { success: 0, failed: 0 };

    const client = await pool.connect();
    let success = 0;
    let failed = 0;

    try {
        await client.query('BEGIN');

        for (const { event, localDbId } of events) {
            try {
                const query = `
                    INSERT INTO photo_captures (
                        timestamp, time_boot_ms, lat, lng, alt_msl, alt_rel,
                        gimbal_pitch, gimbal_roll, gimbal_yaw, gimbal_yaw_absolute,
                        capture_time_iso, camera_feedback_raw, gimbal_orientation_raw,
                        system_time_raw, local_db_id, hostname
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                    ON CONFLICT (local_db_id) DO NOTHING
                `;

                const values = [
                    event.timestamp,
                    event.SystemTime?.timeBootMs,
                    event.CameraFeedbackMessage?.lat,
                    event.CameraFeedbackMessage?.lng,
                    event.CameraFeedbackMessage?.altMsl,
                    event.CameraFeedbackMessage?.altRel,
                    event.GimbalOrientation?.pitch,
                    event.GimbalOrientation?.roll,
                    event.GimbalOrientation?.yaw,
                    event.GimbalOrientation?.yawAbsolute,
                    event.Custom?.dateTimeCaptureISO,
                    JSON.stringify(event.CameraFeedbackMessage),
                    JSON.stringify(event.GimbalOrientation),
                    JSON.stringify(event.SystemTime),
                    localDbId,
                    event.hostname || null
                ];

                await client.query(query, values);
                success++;
            } catch (err) {
                console.error(`Failed to insert event ${localDbId}:`, err.message);
                failed++;
            }
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Batch insert transaction failed:', err);
        throw err;
    } finally {
        client.release();
    }

    return { success, failed };
}

// Close the pool
async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
        console.log('PostgreSQL pool closed');
    }
}

module.exports = {
    initializePostgres,
    testConnection,
    createTableIfNotExists,
    insertPhotoCaptureEvent,
    batchInsertPhotoCaptureEvents,
    closePool
};
