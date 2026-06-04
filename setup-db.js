/**
 * Script de configuracion de base de datos
 * Sistema de Agendamiento - Node.js
 * Ejecutar: npm run setup
 */

const bcrypt = require('bcryptjs');
const { queryAsync, connectDB } = require('./database');

async function addColumnIfMissing(table, column, definition) {
    const columns = await queryAsync(
        `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    if (columns.length === 0) {
        await queryAsync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
}

async function addForeignKeyIfMissing(table, constraintName, definition) {
    const constraints = await queryAsync(
        `SELECT CONSTRAINT_NAME
         FROM information_schema.REFERENTIAL_CONSTRAINTS
         WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?`,
        [table, constraintName]
    );

    if (constraints.length === 0) {
        await queryAsync(`ALTER TABLE ${table} ADD CONSTRAINT ${constraintName} ${definition}`);
    }
}

async function addIndexIfMissing(table, indexName, columns) {
    const indexes = await queryAsync(
        `SELECT INDEX_NAME
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, indexName]
    );
    if (indexes.length === 0) {
        await queryAsync(`ALTER TABLE ${table} ADD INDEX ${indexName} (${columns})`);
    }
}

async function setupUsers() {
    const users = [
        ['admin', 'admin123', 'admin@sistemacitas.com', 'Juan Garcia'],
        ['demo', 'demo123', 'demo@sistemacitas.com', 'Usuario Demo']
    ];

    for (const [username, password, email, fullName] of users) {
        const existing = await queryAsync('SELECT id, password FROM admin_users WHERE username = ?', [username]);
        const passwordHash = await bcrypt.hash(password, 10);
        if (existing.length === 0) {
            await queryAsync(
                'INSERT INTO admin_users (username, password, email, full_name, is_active) VALUES (?, ?, ?, ?, 1)',
                [username, passwordHash, email, fullName]
            );
            continue;
        }

        await queryAsync(
            'UPDATE admin_users SET password = ?, email = ?, full_name = ?, is_active = 1 WHERE id = ?',
            [passwordHash, email, fullName, existing[0].id]
        );
    }
}

async function seedAppointments() {
    const [adminUser] = await queryAsync('SELECT id FROM admin_users WHERE username = ?', ['admin']);
    const [demoUser] = await queryAsync('SELECT id FROM admin_users WHERE username = ?', ['demo']);
    const existingCitas = await queryAsync('SELECT COUNT(*) AS total FROM citas');

    if (!adminUser || !demoUser || existingCitas[0].total > 0) {
        console.log('Nota: ya existen citas o faltan usuarios; no se duplicaron datos.');
        return;
    }

    await queryAsync(`
        INSERT INTO citas
        (user_id, title, all_day, starts_at, duration_minutes, urgency, description, client_name, client_phone, client_email, appointment_date, appointment_time, appointment_type, room, notes, status)
        VALUES
        (?, ?, 0, TIMESTAMP(CURDATE(), ?), ?, ?, ?, ?, ?, ?, CURDATE(), ?, 'general', '', ?, 'confirmada'),
        (?, ?, 0, TIMESTAMP(CURDATE(), ?), ?, ?, ?, ?, ?, ?, CURDATE(), ?, 'general', '', ?, 'pendiente'),
        (?, ?, 0, TIMESTAMP(CURDATE(), ?), ?, ?, ?, ?, ?, ?, CURDATE(), ?, 'general', '', ?, 'confirmada'),
        (?, ?, 0, TIMESTAMP(DATE_ADD(CURDATE(), INTERVAL 1 DAY), ?), ?, ?, ?, ?, ?, ?, DATE_ADD(CURDATE(), INTERVAL 1 DAY), ?, 'general', '', ?, 'pendiente')
    `, [
        adminUser.id, 'Consulta inicial', '09:30', 60, '!', '', 'Maria Lopez', '+34 612 345 678', 'maria@ejemplo.com', '09:30', '',
        adminUser.id, 'Seguimiento mensual', '11:00', 45, '!!', '', 'Carlos Mendez', '+34 623 456 789', 'carlos@ejemplo.com', '11:00', '',
        demoUser.id, 'Primera reunion', '14:30', 60, '!', '', 'Ana Rodriguez', '+34 634 567 890', 'ana@ejemplo.com', '14:30', '',
        demoUser.id, 'Revision prioritaria', '10:00', 30, '!!', '', 'Luis Torres', '+34 645 678 901', 'luis@ejemplo.com', '10:00', ''
    ]);
}

async function setupDatabase() {
    console.log('\nIniciando configuracion de base de datos...\n');

    try {
        const connected = await connectDB();
        if (!connected) {
            throw new Error('No se pudo conectar a la base de datos');
        }

        console.log('Creando tabla de usuarios...');
        await queryAsync(`
            CREATE TABLE IF NOT EXISTS admin_users (
                id INT PRIMARY KEY AUTO_INCREMENT,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                email VARCHAR(100) NOT NULL,
                full_name VARCHAR(100),
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP NULL,
                reset_token VARCHAR(128),
                reset_token_expires TIMESTAMP NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log('Creando tabla de citas...');
        await queryAsync(`
            CREATE TABLE IF NOT EXISTS citas (
                id INT PRIMARY KEY AUTO_INCREMENT,
                user_id INT,
                title VARCHAR(160),
                all_day BOOLEAN DEFAULT FALSE,
                starts_at DATETIME,
                duration_minutes INT DEFAULT 60,
                urgency ENUM('!', '!!', '!!!') DEFAULT '!',
                description TEXT,
                client_name VARCHAR(100),
                client_phone VARCHAR(20),
                client_email VARCHAR(100) NOT NULL,
                appointment_date DATE NOT NULL,
                appointment_time TIME NOT NULL,
                appointment_type ENUM('general', 'follow-up', 'first', 'emergency') DEFAULT 'general',
                room VARCHAR(10),
                notes TEXT,
                status ENUM('confirmada', 'pendiente', 'cancelada') DEFAULT 'confirmada',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                INDEX idx_user (user_id),
                INDEX idx_starts_at (starts_at),
                INDEX idx_urgency (urgency),
                INDEX idx_date (appointment_date),
                INDEX idx_email (client_email),
                INDEX idx_status (status)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        console.log('Creando tabla de auditoria...');
        await queryAsync(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id INT PRIMARY KEY AUTO_INCREMENT,
                admin_id INT,
                action VARCHAR(50),
                entity_type VARCHAR(50),
                entity_id INT,
                details JSON,
                ip_address VARCHAR(45),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (admin_id) REFERENCES admin_users(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        await addColumnIfMissing('citas', 'user_id', 'INT NULL');
        await addColumnIfMissing('citas', 'title', 'VARCHAR(160) NULL');
        await addColumnIfMissing('citas', 'all_day', 'BOOLEAN DEFAULT FALSE');
        await addColumnIfMissing('citas', 'starts_at', 'DATETIME NULL');
        await addColumnIfMissing('citas', 'duration_minutes', 'INT DEFAULT 60');
        await addColumnIfMissing('citas', 'urgency', "ENUM('!', '!!', '!!!') DEFAULT '!'");
        await addColumnIfMissing('citas', 'description', 'TEXT NULL');
        await addColumnIfMissing('admin_users', 'reset_token', 'VARCHAR(128)');
        await addColumnIfMissing('admin_users', 'reset_token_expires', 'TIMESTAMP NULL');
        await addIndexIfMissing('citas', 'idx_starts_at', 'starts_at');
        await addIndexIfMissing('citas', 'idx_urgency', 'urgency');

        console.log('Creando usuarios iniciales...');
        await setupUsers();

        const firstUser = await queryAsync('SELECT id FROM admin_users ORDER BY id LIMIT 1');
        if (firstUser.length > 0) {
            await queryAsync('UPDATE citas SET user_id = ? WHERE user_id IS NULL', [firstUser[0].id]);
            await queryAsync(`
                UPDATE citas c
                LEFT JOIN admin_users u ON u.id = c.user_id
                SET c.user_id = ?
                WHERE u.id IS NULL
            `, [firstUser[0].id]);
        }

        await queryAsync(`
            UPDATE citas
            SET
                title = COALESCE(NULLIF(title, ''), client_name, 'Servicio sin titulo'),
                starts_at = COALESCE(starts_at, TIMESTAMP(appointment_date, appointment_time)),
                duration_minutes = COALESCE(NULLIF(duration_minutes, 0), 60),
                urgency = COALESCE(urgency, CASE WHEN appointment_type = 'emergency' THEN '!!!' ELSE '!' END),
                description = COALESCE(description, notes)
            WHERE title IS NULL OR starts_at IS NULL OR urgency IS NULL
        `);

        await queryAsync('ALTER TABLE citas MODIFY title VARCHAR(160) NOT NULL');
        await queryAsync('ALTER TABLE citas MODIFY starts_at DATETIME NOT NULL');
        await queryAsync('ALTER TABLE citas MODIFY client_name VARCHAR(100) NULL');

        await addForeignKeyIfMissing(
            'citas',
            'fk_citas_user',
            'FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE'
        );
        await queryAsync('ALTER TABLE citas MODIFY user_id INT NOT NULL');

        console.log('Insertando datos de prueba por usuario...');
        await seedAppointments();

        console.log('\nBASE DE DATOS CONFIGURADA EXITOSAMENTE');
        console.log('Credenciales de prueba:');
        console.log('  admin / admin123');
        console.log('  demo  / demo123');
        console.log('\nProximo paso: npm start\n');

        process.exit(0);
    } catch (error) {
        console.error('\nError:', error.message);
        console.error('\nVerificar:');
        console.error('  - MySQL esta corriendo');
        console.error('  - Credenciales en .env son correctas');
        console.error('  - La base de datos existe\n');
        process.exit(1);
    }
}

setupDatabase();
