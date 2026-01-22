const knex = require('knex');

class DbManager {
    constructor() {
        this.db = null;
    }

    async connect(config) {
        // Close existing connection if any
        if (this.db) {
            await this.db.destroy();
        }

        const dbConfig = {
            client: config.type, // 'mysql2', 'pg', 'mssql'
            connection: {
                host: config.host,
                port: parseInt(config.port),
                user: config.user,
                password: config.password,
                database: config.database,
                // specific options for mssql
                options: config.type === 'mssql' ? { encrypt: false } : undefined
            }
        };

        try {
            this.db = knex(dbConfig);
            // Test connection
            await this.db.raw('SELECT 1');
            return { success: true, message: 'Connected successfully' };
        } catch (error) {
            console.error("DB Connection Error:", error);
            this.db = null;
            return { success: false, message: error.message };
        }
    }

    async executeQuery(query) {
        if (!this.db) {
            throw new Error("Database not connected");
        }
        try {
            const result = await this.db.raw(query);
            
            // Normalize results based on DB type
            // Knex raw returns different structures for different drivers
            let rows = [];
            
            // This is a simplified normalization; might need adjustment based on specific driver versions
            if (result.rows) {
                rows = result.rows; // Postgres
            } else if (Array.isArray(result) && Array.isArray(result[0])) {
                 // MySQL often returns [rows, fields]
                 rows = result[0];
            } else if (Array.isArray(result)) {
                rows = result; // MySQL/Sqlite sometimes
            } else {
                 rows = result; // MSSQL usually returns the recordset directly or in an object
            }
            
            return rows;
        } catch (error) {
            throw error;
        }
    }

    getStream(query) {
        if (!this.db) {
            throw new Error("Database not connected");
        }
        // Return the Knex stream directly
        return this.db.raw(query).stream();
    }
}

module.exports = new DbManager();
