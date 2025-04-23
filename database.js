// db.js
const Datastore = require('nedb');
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
        return new Promise((resolve, reject) => {
            db.insert(photoCaptureEvent, (err, newDoc) => {
                if (err) reject(err);
                else resolve(newDoc);
            });
        });
    };

    return db;
}

// Export just the functions
module.exports = {
    clearDatabase,
    initializeDatabase
};
