/**
 * Configuración de Base de Datos
 * Sistema de Agendamiento de Citas - Node.js
 */

const mysql = require('mysql2/promise');
require('dotenv').config();

// Configuración
const config = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || 'Daviti.12345',
    database: process.env.DB_NAME || 'sistema_citas',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true
};

// Pool de conexiones
const pool = mysql.createPool(config);

/**
 * Ejecutar query con pool
 */
async function queryAsync(sql, params = []) {
    const connection = await pool.getConnection();
    try {
        const [results] = await connection.execute(sql, params);
        return results;
    } finally {
        connection.release();
    }
}

/**
 * Conectar a la base de datos
 */
async function connectDB() {
    try {
        const connection = await pool.getConnection();
        await connection.ping();
        connection.release();
        console.log('✅ Conectado a MySQL exitosamente');
        return true;
    } catch (error) {
        console.error('❌ Error conectando a MySQL:', error.message);
        return false;
    }
}

module.exports = {
    pool,
    queryAsync,
    connectDB,
    config
};
