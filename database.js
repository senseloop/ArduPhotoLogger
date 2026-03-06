// db.js
const Datastore = require('@seald-io/nedb');
const fs = require('fs');

const dbFile = 'database.db';
let db = null;

// Function to clear the database file
function clearDatabase() {
    if (fs.existsSync(dbFile)) {
        fs.unlinkSync(dbFile);
        console.log('Database cleared.');
    } else {
        console.log('No existing database found.');
    }
}

// Function to initialize the database ONCE
function initializeDatabase() {
    if (db) return db; // already initialized

    db = new Datastore({ filename: dbFile, autoload: true });

    db.insertPhotoCaptureEvent = function (photoCaptureEvent) {
        // Add sync tracking fields
        const eventWithSync = {
            ...photoCaptureEvent,
            synced: false,
            syncAttempts: 0,
            lastSyncAttempt: null,
            createdAt: new Date().toISOString()
        };

        return new Promise((resolve, reject) => {
            db.insert(eventWithSync, (err, newDoc) => {
                if (err) reject(err);
                else resolve(newDoc);
            });
        });
    };

    // Get unsynced photo capture events
    db.getUnsyncedEvents = function (limit = 50) {
        return new Promise((resolve, reject) => {
            db.find({ synced: false })
                .sort({ createdAt: 1 })
                .limit(limit)
                .exec((err, docs) => {
                    if (err) reject(err);
                    else resolve(docs);
                });
        });
    };

    // Mark event as synced
    db.markAsSynced = function (docId) {
        return new Promise((resolve, reject) => {
            db.update(
                { _id: docId },
                { $set: { synced: true, syncedAt: new Date().toISOString() } },
                {},
                (err, numReplaced) => {
                    if (err) reject(err);
                    else resolve(numReplaced);
                }
            );
        });
    };

    // Mark sync attempt
    db.markSyncAttempt = function (docId) {
        return new Promise((resolve, reject) => {
            db.update(
                { _id: docId },
                { 
                    $set: { lastSyncAttempt: new Date().toISOString() },
                    $inc: { syncAttempts: 1 }
                },
                {},
                (err, numReplaced) => {
                    if (err) reject(err);
                    else resolve(numReplaced);
                }
            );
        });
    };

    // Clean up old synced records
    db.cleanupSyncedRecords = function (olderThanHours = 24) {
        return new Promise((resolve, reject) => {
            const cutoffDate = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();
            db.remove(
                { synced: true, syncedAt: { $lt: cutoffDate } },
                { multi: true },
                (err, numRemoved) => {
                    if (err) reject(err);
                    else resolve(numRemoved);
                }
            );
        });
    };

    return db;
}

// Export just the functions
module.exports = {
    clearDatabase,
    initializeDatabase
};
