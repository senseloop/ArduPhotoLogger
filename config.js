const fs = require('fs');
const path = require('path');
const ini = require('ini');

class Config {
    constructor(configPath = './config.conf') {
        this.configPath = configPath;
        this.config = this.loadConfig();
    }

    loadConfig() {
        try {
            const configFile = fs.readFileSync(this.configPath, 'utf-8');
            const parsed = ini.parse(configFile);
            
            // Provide defaults for missing values
            const config = {
                mavlink: {
                    address: parsed.mavlink?.address || parsed.mavlink?.addreess || 'udp://:14550',
                    port: parseInt(parsed.mavlink?.port) || 14559,
                    host: parsed.mavlink?.host || 'localhost'
                },
                nmea_objects: {
                    enabled: parsed.nmea_objects?.enabled === 'true' || parsed.nmea_objects?.enabled === true
                },
                server: {
                    port: parseInt(parsed.server?.port) || process.env.PORT || 3000,
                    websocket_enabled: parsed.server?.websocket_enabled !== 'false'
                },
                features: {
                    photo_capture: parsed.features?.photo_capture !== 'false',
                    adsb_handler: parsed.features?.adsb_handler !== 'false',
                    database_logging: parsed.features?.database_logging !== 'false'
                },
                sync: {
                    sync_enabled: parsed.sync?.sync_enabled === 'true' || parsed.sync?.sync_enabled === true,
                    sync_interval_ms: parseInt(parsed.sync?.sync_interval_ms) || 30000,
                    sync_batch_size: parseInt(parsed.sync?.sync_batch_size) || 50,
                    sync_max_retries: parseInt(parsed.sync?.sync_max_retries) || 5,
                    sync_cleanup_hours: parseInt(parsed.sync?.sync_cleanup_hours) || 24
                },
                postgres: {
                    host: parsed.postgres?.host || 'localhost',
                    port: parseInt(parsed.postgres?.port) || 5432,
                    database: parsed.postgres?.database || 'photolog',
                    table: parsed.postgres?.table || 'photolog',
                    user: parsed.postgres?.user || 'postgres',
                    password: parsed.postgres?.password || ''
                }
            };

            console.log('Configuration loaded from:', this.configPath);
            return config;
        } catch (error) {
            console.warn(`Could not load config file: ${error.message}`);
            console.warn('Using default configuration');
            return this.getDefaultConfig();
        }
    }

    getDefaultConfig() {
        return {
            mavlink: {
                address: 'udp://:14550',
                port: 14559,
                host: 'localhost'
            },
            nmea_objects: {
                enabled: true
            },
            server: {
                port: process.env.PORT || 3000,
                websocket_enabled: true
            },
            features: {
                photo_capture: true,
                adsb_handler: true,
                database_logging: true
            }
        };
    }

    get(section, key) {
        if (section && key) {
            return this.config[section]?.[key];
        }
        if (section) {
            return this.config[section];
        }
        return this.config;
    }

    reload() {
        this.config = this.loadConfig();
        return this.config;
    }
}

// Export a singleton instance
const config = new Config();
module.exports = config;
