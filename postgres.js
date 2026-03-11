// PostgreSQL connection and operations module
const { Pool } = require('pg');
const config = require('./config');

let pool = null;

// Message buffering for periodic logging
let messageBuffer = {
    inserts: 0,
    insertSuccesses: 0,
    insertSkipped: 0,
    insertErrors: [],
    batchInserts: 0,
    batchSuccesses: 0,
    batchFailures: 0,
    lastFlush: Date.now()
};

// Flush buffered messages every 5 seconds
function flushMessageBuffer() {
    const now = Date.now();
    if (now - messageBuffer.lastFlush >= 5000) {
        if (messageBuffer.inserts > 0 || messageBuffer.batchInserts > 0) {
            console.log('=== PostgreSQL Activity (last 5 seconds) ===');
            if (messageBuffer.inserts > 0) {
                console.log(`Single inserts: ${messageBuffer.insertSuccesses} succeeded, ${messageBuffer.insertSkipped} skipped (duplicates)`);
            }
            if (messageBuffer.batchInserts > 0) {
                console.log(`Batch inserts: ${messageBuffer.batchInserts} batches, ${messageBuffer.batchSuccesses} total succeeded, ${messageBuffer.batchFailures} total failed`);
            }
            if (messageBuffer.insertErrors.length > 0) {
                console.log(`Errors in last 5 seconds: ${messageBuffer.insertErrors.length}`);
                messageBuffer.insertErrors.forEach((err, idx) => {
                    console.error(`  Error ${idx + 1}: [${err.code}] ${err.message}`);
                    if (err.detail) console.error(`    Detail: ${err.detail}`);
                    if (err.hint) console.error(`    Hint: ${err.hint}`);
                });
            }
        }
        
        // Reset buffer
        messageBuffer = {
            inserts: 0,
            insertSuccesses: 0,
            insertSkipped: 0,
            insertErrors: [],
            batchInserts: 0,
            batchSuccesses: 0,
            batchFailures: 0,
            lastFlush: now
        };
    }
}

// Start periodic buffer flushing
setInterval(flushMessageBuffer, 5000);

// Initialize PostgreSQL connection pool
function initializePostgres() {
    if (pool) return pool;

    const postgresConfig = config.get('postgres');
    
    console.log('=== Initializing PostgreSQL Connection ===');
    console.log(`Host: ${postgresConfig.host}`);
    console.log(`Port: ${postgresConfig.port}`);
    console.log(`Database: ${postgresConfig.database}`);
    console.log(`User: ${postgresConfig.user}`);
    console.log(`Table: ${postgresConfig.table}`);
    
    pool = new Pool({
        host: postgresConfig.host,
        port: postgresConfig.port,
        database: postgresConfig.database,
        user: postgresConfig.user,
        password: postgresConfig.password,
        // Connection pool settings
        max: 5, // Maximum number of clients in the pool
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
        console.error('=== Unexpected PostgreSQL pool error ===');
        console.error('Error message:', err.message);
        console.error('Error code:', err.code);
        console.error('Error stack:', err.stack);
    });

    console.log('PostgreSQL connection pool initialized');
    return pool;
}

// Test connection to PostgreSQL
async function testConnection() {
    if (!pool) {
        console.error('PostgreSQL pool not initialized');
        return false;
    }
    
    let client;
    try {
        client = await pool.connect();
        const result = await client.query('SELECT NOW()');
        client.release();
        return true;
    } catch (err) {
        console.error('=== PostgreSQL Connection Test FAILED ===');
        console.error('Error message:', err.message);
        console.error('Error code:', err.code);
        
        // Release client if we acquired it
        if (client) {
            try {
                client.release(true); // true = discard the client
            } catch (releaseErr) {
                // Ignore release errors
            }
        }
        return false;
    }
}

// Insert a photo capture event into PostgreSQL
async function insertPhotoCaptureEvent(event, localDbId) {
    const tableName = config.get('postgres', 'table');
    const query = `
        INSERT INTO ${tableName} (
            timestamp,
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
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        ON CONFLICT (local_db_id) DO NOTHING
        RETURNING id
    `;

    const values = [
        event.timestamp,
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
        messageBuffer.inserts++;
        const result = await pool.query(query, values);
        if (result.rowCount > 0) {
            messageBuffer.insertSuccesses++;
            return result.rows[0].id;
        } else {
            messageBuffer.insertSkipped++;
            return null;
        }
    } catch (err) {
        // Always log critical errors immediately
        console.error('=== CRITICAL: Failed to Insert Photo Capture Event ===');
        console.error('Error message:', err.message);
        console.error('Error code:', err.code);
        console.error('Error detail:', err.detail);
        console.error('Error hint:', err.hint);
        console.error('Error constraint:', err.constraint);
        console.error('Error column:', err.column);
        console.error('Error table:', err.table);
        console.error('Query:', query);
        console.error('Values summary:', {
            timestamp: values[0],
            lat: values[1],
            lng: values[2],
            local_db_id: values[13],
            hostname: values[14]
        });
        console.error('Full error stack:', err.stack);
        
        messageBuffer.insertErrors.push({
            code: err.code,
            message: err.message,
            detail: err.detail,
            hint: err.hint
        });
        throw err;
    }
}

// Batch insert multiple photo capture events
async function batchInsertPhotoCaptureEvents(events) {
    if (!events || events.length === 0) {
        return { success: 0, failed: 0 };
    }

    messageBuffer.batchInserts++;
    const client = await pool.connect();
    const tableName = config.get('postgres', 'table');
    let success = 0;
    let failed = 0;

    try {
        await client.query('BEGIN');

        for (const { event, localDbId } of events) {
            try {
                const query = `
                    INSERT INTO ${tableName} (
                        timestamp, lat, lng, alt_msl, alt_rel,
                        gimbal_pitch, gimbal_roll, gimbal_yaw, gimbal_yaw_absolute,
                        capture_time_iso, camera_feedback_raw, gimbal_orientation_raw,
                        system_time_raw, local_db_id, hostname
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                    ON CONFLICT (local_db_id) DO NOTHING
                `;

                const values = [
                    event.timestamp,
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
                // Log first error of batch immediately for debugging
                if (failed === 0) {
                    console.error(`=== CRITICAL: First Batch Insert Error (Event ${localDbId}) ===`);
                    console.error('Error message:', err.message);
                    console.error('Error code:', err.code);
                    console.error('Error detail:', err.detail);
                    console.error('Error hint:', err.hint);
                    console.error('Error constraint:', err.constraint);
                    console.error('Event data:', {
                        timestamp: event.timestamp,
                        lat: event.CameraFeedbackMessage?.lat,
                        lng: event.CameraFeedbackMessage?.lng,
                        localDbId: localDbId
                    });
                }
                messageBuffer.insertErrors.push({
                    code: err.code,
                    message: err.message,
                    detail: err.detail,
                    hint: err.hint,
                    localDbId: localDbId
                });
                failed++;
            }
        }

        await client.query('COMMIT');
        messageBuffer.batchSuccesses += success;
        messageBuffer.batchFailures += failed;
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('=== CRITICAL: Batch Insert Transaction FAILED ===');
        console.error('Error message:', err.message);
        console.error('Error code:', err.code);
        console.error('Error detail:', err.detail);
        console.error('Error stack:', err.stack);
        console.error(`Rolled back. ${success} succeeded before failure, ${failed} had failed`);
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

// Fetch latest records from PostgreSQL
async function fetchLatestRecords(limit = 100) {
    if (!pool) {
        throw new Error('PostgreSQL pool not initialized. Call initializePostgres() first.');
    }

    const postgresConfig = config.get('postgres');
    const tableName = postgresConfig.table || 'photo_captures';

    try {
        const query = `
            SELECT * FROM ${tableName}
            ORDER BY timestamp DESC
            LIMIT $1
        `;
        
        const result = await pool.query(query, [limit]);
        return result.rows;
    } catch (error) {
        console.error('=== Error fetching records from PostgreSQL ===');
        console.error('Error message:', error.message);
        console.error('Error code:', error.code);
        console.error('Error detail:', error.detail);
        console.error('Error stack:', error.stack);
        throw error;
    }
}

module.exports = {
    initializePostgres,
    testConnection,
    insertPhotoCaptureEvent,
    batchInsertPhotoCaptureEvents,
    fetchLatestRecords,
    closePool
};
