/**
 * Servidor Express - Sistema de Agendamiento de Citas
 * Node.js backend completo
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const { connectDB, queryAsync } = require('./database');

const app = express();
const PORT = process.env.PORT || 8001;
const sessions = new Map();

const CITAS_SELECT = `
    SELECT
        id,
        user_id,
        title,
        all_day,
        DATE_FORMAT(starts_at, '%Y-%m-%dT%H:%i') AS starts_at,
        duration_minutes,
        urgency,
        description,
        DATE_FORMAT(starts_at, '%Y-%m-%d') AS appointment_date,
        TIME_FORMAT(starts_at, '%H:%i:%s') AS appointment_time,
        client_name,
        client_phone,
        client_email,
        appointment_type,
        room,
        notes,
        status,
        created_at,
        updated_at
    FROM citas
`;

const PUBLIC_PATHS = new Set([
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/forgot-password',
    '/api/auth/logout'
]);

function normalizeUrgency(urgency) {
    return ['!', '!!', '!!!'].includes(urgency) ? urgency : '!';
}

function normalizeAllDay(value) {
    return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function normalizeDurationMinutes(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 60;
    return Math.min(parsed, 1440);
}

function buildStartsAtFromLegacy(body) {
    if (body.starts_at) return String(body.starts_at).replace('T', ' ').slice(0, 16);
    if (body.appointment_date) {
        return `${body.appointment_date} ${body.appointment_time || '09:00'}`.slice(0, 16);
    }
    return '';
}

function normalizeAppointmentPayload(body) {
    const title = String(body.title || body.client_name || '').trim();
    const startsAt = buildStartsAtFromLegacy(body);
    const clientName = String(body.client_name || body.client || '').trim();

    return {
        title,
        allDay: normalizeAllDay(body.all_day),
        startsAt,
        durationMinutes: normalizeDurationMinutes(body.duration_minutes || body.duration),
        urgency: normalizeUrgency(body.urgency),
        description: String(body.description || body.notes || '').trim(),
        clientName
    };
}

function validateAppointmentInput(appointment) {
    if (!appointment.title) {
        return 'Ingrese un titulo';
    }

    if (!appointment.startsAt || Number.isNaN(new Date(appointment.startsAt.replace(' ', 'T')).getTime())) {
        return 'Ingrese una fecha y hora de inicio validas';
    }

    if (!['!', '!!', '!!!'].includes(appointment.urgency)) {
        return 'Seleccione un nivel de urgencia valido';
    }

    return null;
}

function publicUser(user) {
    if (!user) return null;

    return {
        id: user.id,
        username: user.username,
        email: user.email,
        full_name: user.full_name
    };
}

function getTokenFromRequest(req) {
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    return req.headers['x-session-token'] || null;
}

function requireAuth(req, res, next) {
    if (!req.path.startsWith('/api/') || PUBLIC_PATHS.has(req.path)) {
        return next();
    }

    const token = getTokenFromRequest(req);
    const session = token ? sessions.get(token) : null;

    if (!session) {
        return sendResponse(res, false, 'SesiÃ³n requerida', null, 401);
    }

    req.user = session.user;
    req.sessionToken = token;
    next();
}

async function ensureDatabaseSchema() {
    await queryAsync(`
        CREATE TABLE IF NOT EXISTS admin_users (
            id INT PRIMARY KEY AUTO_INCREMENT,
            username VARCHAR(50) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            email VARCHAR(100) NOT NULL,
            full_name VARCHAR(100),
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_login TIMESTAMP,
            reset_token VARCHAR(128),
            reset_token_expires TIMESTAMP NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

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

    await addColumnIfMissing('admin_users', 'reset_token', 'VARCHAR(128)');
    await addColumnIfMissing('admin_users', 'reset_token_expires', 'TIMESTAMP NULL');
    await addColumnIfMissing('citas', 'user_id', 'INT NULL');
    await addColumnIfMissing('citas', 'title', 'VARCHAR(160) NULL');
    await addColumnIfMissing('citas', 'all_day', 'BOOLEAN DEFAULT FALSE');
    await addColumnIfMissing('citas', 'starts_at', 'DATETIME NULL');
    await addColumnIfMissing('citas', 'duration_minutes', 'INT DEFAULT 60');
    await addColumnIfMissing('citas', 'urgency', "ENUM('!', '!!', '!!!') DEFAULT '!'");
    await addColumnIfMissing('citas', 'description', 'TEXT NULL');
    await addIndexIfMissing('citas', 'idx_starts_at', 'starts_at');
    await addIndexIfMissing('citas', 'idx_urgency', 'urgency');

    await seedDefaultUsers();

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

    await queryAsync("ALTER TABLE citas MODIFY title VARCHAR(160) NOT NULL");
    await queryAsync("ALTER TABLE citas MODIFY starts_at DATETIME NOT NULL");
    await queryAsync("ALTER TABLE citas MODIFY client_name VARCHAR(100) NULL");

    await addForeignKeyIfMissing(
        'citas',
        'fk_citas_user',
        'FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE'
    );
    await queryAsync('ALTER TABLE citas MODIFY user_id INT NOT NULL');
}

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

async function seedDefaultUsers() {
    const users = [
        ['admin', 'admin123', 'admin@sistemacitas.com', 'Juan GarcÃ­a'],
        ['demo', 'demo123', 'demo@sistemacitas.com', 'Usuario Demo']
    ];

    for (const [username, password, email, fullName] of users) {
        const existing = await queryAsync('SELECT id FROM admin_users WHERE username = ?', [username]);
        const passwordHash = await bcrypt.hash(password, 10);
        if (existing.length === 0) {
            await queryAsync(
                'INSERT INTO admin_users (username, password, email, full_name, is_active) VALUES (?, ?, ?, ?, 1)',
                [username, passwordHash, email, fullName]
            );
        } else {
            await queryAsync(
                'UPDATE admin_users SET password = ?, email = ?, full_name = ?, is_active = 1 WHERE id = ?',
                [passwordHash, email, fullName, existing[0].id]
            );
        }
    }
}

function validateRegisterInput({ username, email, password, full_name }) {
    if (!username || !email || !password || !full_name) {
        return 'Complete todos los campos';
    }

    if (!/^[a-zA-Z0-9._-]{3,50}$/.test(username)) {
        return 'El usuario debe tener minimo 3 caracteres';
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return 'Ingrese un correo valido';
    }

    if (password.length < 6) {
        return 'La contrasena debe tener minimo 6 caracteres';
    }

    return null;
}

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
//app.use(express.static(path.join(__dirname, '../frontend')));

// Middleware de logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

app.use(requireAuth);

// ============================================
// RESPUESTA ESTÃNDAR
// ============================================

function sendResponse(res, success = true, message = '', data = null, statusCode = 200) {
    res.status(statusCode).json({
        success,
        message,
        data,
        timestamp: new Date().toISOString()
    });
}

// ============================================
// RUTAS - AUTENTICACIÃ“N
// ============================================

app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return sendResponse(res, false, 'Ingrese usuario y contraseÃ±a', null, 400);
        }

        const users = await queryAsync(
            'SELECT id, username, password, email, full_name, is_active FROM admin_users WHERE username = ? OR email = ? LIMIT 1',
            [username, username]
        );

        const user = users[0];
        if (!user || !user.is_active) {
            return sendResponse(res, false, 'Credenciales invÃ¡lidas', null, 401);
        }

        let validPassword = false;
        if (String(user.password).startsWith('$2')) {
            validPassword = await bcrypt.compare(password, user.password);
        } else {
            validPassword = password === user.password;
            if (validPassword) {
                const passwordHash = await bcrypt.hash(password, 10);
                await queryAsync('UPDATE admin_users SET password = ? WHERE id = ?', [passwordHash, user.id]);
            }
        }

        if (!validPassword) {
            return sendResponse(res, false, 'Credenciales invÃ¡lidas', null, 401);
        }

        await queryAsync('UPDATE admin_users SET last_login = NOW() WHERE id = ?', [user.id]);

        const token = crypto.randomBytes(32).toString('hex');
        const safeUser = publicUser(user);
        sessions.set(token, {
            user: safeUser,
            createdAt: Date.now()
        });

        sendResponse(res, true, 'Inicio de sesiÃ³n correcto', { token, user: safeUser });
    } catch (error) {
        console.error('Error login:', error);
        sendResponse(res, false, 'Error al iniciar sesiÃ³n', null, 500);
    }
});

app.post('/api/auth/register', async (req, res) => {
    try {
        const username = String(req.body.username || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const full_name = String(req.body.full_name || '').trim();
        const password = String(req.body.password || '');

        const validationError = validateRegisterInput({ username, email, password, full_name });
        if (validationError) {
            return sendResponse(res, false, validationError, null, 400);
        }

        const existing = await queryAsync(
            'SELECT id FROM admin_users WHERE username = ? OR email = ? LIMIT 1',
            [username, email]
        );

        if (existing.length > 0) {
            return sendResponse(res, false, 'Ese usuario o correo ya existe', null, 409);
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const result = await queryAsync(
            'INSERT INTO admin_users (username, password, email, full_name, is_active) VALUES (?, ?, ?, ?, 1)',
            [username, passwordHash, email, full_name]
        );

        const safeUser = {
            id: result.insertId,
            username,
            email,
            full_name
        };
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, {
            user: safeUser,
            createdAt: Date.now()
        });

        sendResponse(res, true, 'Usuario registrado correctamente', { token, user: safeUser }, 201);
    } catch (error) {
        console.error('Error registro:', error);
        sendResponse(res, false, 'Error al registrar usuario', null, 500);
    }
});

app.get('/api/auth/me', (req, res) => {
    sendResponse(res, true, 'SesiÃ³n activa', req.user);
});

app.post('/api/auth/logout', (req, res) => {
    const token = getTokenFromRequest(req);
    if (token) sessions.delete(token);
    sendResponse(res, true, 'SesiÃ³n cerrada');
});

app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return sendResponse(res, false, 'Ingrese su correo electrÃ³nico', null, 400);
        }

        const users = await queryAsync('SELECT id FROM admin_users WHERE email = ? LIMIT 1', [email]);
        if (users.length > 0) {
            const resetToken = crypto.randomBytes(24).toString('hex');
            await queryAsync(
                'UPDATE admin_users SET reset_token = ?, reset_token_expires = DATE_ADD(NOW(), INTERVAL 30 MINUTE) WHERE id = ?',
                [resetToken, users[0].id]
            );
            console.log(`Token de recuperaciÃ³n para ${email}: ${resetToken}`);
        }

        sendResponse(res, true, 'Si el correo existe, se generÃ³ una solicitud de recuperaciÃ³n.');
    } catch (error) {
        console.error('Error recuperaciÃ³n:', error);
        sendResponse(res, false, 'Error al procesar la recuperaciÃ³n', null, 500);
    }
});

// ============================================
// RUTAS - CITAS
// ============================================

/**
 * GET /api/citas - Obtener todas las citas
 */
app.get('/api/citas', async (req, res) => {
    try {
        const citas = await queryAsync(
            `${CITAS_SELECT} WHERE user_id = ? ORDER BY starts_at`,
            [req.user.id]
        );
        sendResponse(res, true, 'Citas obtenidas exitosamente', citas);
    } catch (error) {
        console.error('Error obtener citas:', error);
        sendResponse(res, false, 'Error al obtener citas', null, 500);
    }
});

/**
 * GET /api/citas/:id - Obtener cita especÃ­fica
 */
app.get('/api/citas/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cita = await queryAsync(
            `${CITAS_SELECT} WHERE id = ? AND user_id = ?`,
            [id, req.user.id]
        );
        
        if (cita.length === 0) {
            return sendResponse(res, false, 'Cita no encontrada', null, 404);
        }
        
        sendResponse(res, true, 'Cita obtenida', cita[0]);
    } catch (error) {
        console.error('Error obtener cita:', error);
        sendResponse(res, false, 'Error al obtener cita', null, 500);
    }
});

/**
 * POST /api/citas - Crear nuevo servicio/evento
 */
app.post('/api/citas', async (req, res) => {
    try {
        const appointment = normalizeAppointmentPayload(req.body);
        const validationError = validateAppointmentInput(appointment);
        if (validationError) {
            return sendResponse(res, false, validationError, null, 400);
        }

        const result = await queryAsync(
            `INSERT INTO citas
             (user_id, title, all_day, starts_at, duration_minutes, urgency, description, client_name, client_phone, client_email, appointment_date, appointment_time, appointment_type, room, notes, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', DATE(?), TIME(?), 'general', '', ?, 'confirmada', NOW())`,
            [
                req.user.id,
                appointment.title,
                appointment.allDay ? 1 : 0,
                appointment.startsAt,
                appointment.durationMinutes,
                appointment.urgency,
                appointment.description,
                appointment.clientName || null,
                appointment.startsAt,
                appointment.startsAt,
                appointment.description
            ]
        );

        const nuevaCita = await queryAsync(`${CITAS_SELECT} WHERE id = ? AND user_id = ?`, [result.insertId, req.user.id]);
        sendResponse(res, true, 'Servicio creado exitosamente', nuevaCita[0], 201);
    } catch (error) {
        console.error('Error crear servicio:', error);
        sendResponse(res, false, 'Error al crear servicio', null, 500);
    }
});

/**
 * PUT /api/citas/:id - Actualizar servicio/evento
 */
app.put('/api/citas/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const appointment = normalizeAppointmentPayload(req.body);
        const validationError = validateAppointmentInput(appointment);
        if (validationError) {
            return sendResponse(res, false, validationError, null, 400);
        }

        await queryAsync(
            `UPDATE citas SET
             title = ?,
             all_day = ?,
             starts_at = ?,
             duration_minutes = ?,
             urgency = ?,
             description = ?,
             client_name = ?,
             appointment_date = DATE(?),
             appointment_time = TIME(?),
             notes = ?
             WHERE id = ? AND user_id = ?`,
            [
                appointment.title,
                appointment.allDay ? 1 : 0,
                appointment.startsAt,
                appointment.durationMinutes,
                appointment.urgency,
                appointment.description,
                appointment.clientName || null,
                appointment.startsAt,
                appointment.startsAt,
                appointment.description,
                id,
                req.user.id
            ]
        );

        const citaActualizada = await queryAsync(`${CITAS_SELECT} WHERE id = ? AND user_id = ?`, [id, req.user.id]);
        if (citaActualizada.length === 0) {
            return sendResponse(res, false, 'Servicio no encontrado', null, 404);
        }
        sendResponse(res, true, 'Servicio actualizado exitosamente', citaActualizada[0] || null);
    } catch (error) {
        console.error('Error actualizar servicio:', error);
        sendResponse(res, false, 'Error al actualizar servicio', null, 500);
    }
});

/**
 * DELETE /api/citas/:id - Eliminar/Cancelar cita
 */
app.delete('/api/citas/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await queryAsync(
            'DELETE FROM citas WHERE id = ? AND user_id = ?',
            [id, req.user.id]
        );

        if (result.affectedRows === 0) {
            return sendResponse(res, false, 'Cita no encontrada', null, 404);
        }

        sendResponse(res, true, 'Cita eliminada exitosamente');
    } catch (error) {
        console.error('Error eliminar cita:', error);
        sendResponse(res, false, 'Error al eliminar cita', null, 500);
    }
});

// ============================================
// RUTAS - CLIENTES
// ============================================

/**
 * GET /api/clientes - Obtener todos los clientes
 */
app.get('/api/clientes', async (req, res) => {
    try {
        const clientes = await queryAsync(
            `SELECT DISTINCT 
             client_name, 
             client_phone, 
             client_email, 
             COUNT(id) as total_citas,
             DATE_FORMAT(MAX(appointment_date), '%Y-%m-%d') as ultima_cita
             FROM citas 
             WHERE user_id = ?
             GROUP BY client_email, client_name, client_phone
             ORDER BY client_name ASC`,
            [req.user.id]
        );
        sendResponse(res, true, 'Clientes obtenidos', clientes);
    } catch (error) {
        console.error('Error obtener clientes:', error);
        sendResponse(res, false, 'Error al obtener clientes', null, 500);
    }
});

/**
 * GET /api/clientes/buscar - Buscar clientes
 */
app.get('/api/clientes/buscar', async (req, res) => {
    try {
        const { search } = req.query;
        
        if (!search || search.length < 2) {
            return sendResponse(res, false, 'Ingrese al menos 2 caracteres', null, 400);
        }

        const searchTerm = `%${search}%`;
        const clientes = await queryAsync(
            `SELECT DISTINCT 
             client_name, 
             client_phone, 
             client_email, 
             COUNT(id) as total_citas,
             DATE_FORMAT(MAX(appointment_date), '%Y-%m-%d') as ultima_cita
             FROM citas 
             WHERE user_id = ? AND (client_name LIKE ? OR client_phone LIKE ? OR client_email LIKE ?)
             GROUP BY client_email, client_name, client_phone
             ORDER BY client_name ASC`,
            [req.user.id, searchTerm, searchTerm, searchTerm]
        );
        sendResponse(res, true, 'BÃºsqueda completada', clientes);
    } catch (error) {
        console.error('Error buscar clientes:', error);
        sendResponse(res, false, 'Error en bÃºsqueda', null, 500);
    }
});

// ============================================
// RUTAS - ESTADÃSTICAS
// ============================================

/**
 * GET /api/estadisticas - Obtener estadÃ­sticas del dÃ­a
 */
app.get('/api/estadisticas', async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];

        const urgentes = await queryAsync(
            'SELECT COUNT(*) as count FROM citas WHERE user_id = ? AND DATE(starts_at) = ? AND urgency = "!!!"',
            [req.user.id, today]
        );

        const prioridadMedia = await queryAsync(
            'SELECT COUNT(*) as count FROM citas WHERE user_id = ? AND DATE(starts_at) = ? AND urgency = "!!"',
            [req.user.id, today]
        );

        const proximas = await queryAsync(
            `SELECT id, title, all_day, DATE_FORMAT(starts_at, '%Y-%m-%dT%H:%i') AS starts_at, duration_minutes, urgency, description, client_name,
                    DATE_FORMAT(starts_at, '%Y-%m-%d') AS appointment_date, TIME_FORMAT(starts_at, '%H:%i:%s') AS appointment_time
             FROM citas 
             WHERE user_id = ? AND starts_at >= NOW() AND starts_at <= DATE_ADD(NOW(), INTERVAL 1 DAY)
             ORDER BY starts_at
             LIMIT 5`,
            [req.user.id]
        );

        const ocupados = await queryAsync(
            'SELECT COUNT(*) as count FROM citas WHERE user_id = ? AND DATE(starts_at) = ?',
            [req.user.id, today]
        );

        const stats = {
            urgentes: urgentes[0].count,
            prioridadMedia: prioridadMedia[0].count,
            disponibles: 30 - ocupados[0].count, // 30 slots diarios
            proximas: proximas
        };

        sendResponse(res, true, 'EstadÃ­sticas obtenidas', stats);
    } catch (error) {
        console.error('Error obtener estadÃ­sticas:', error);
        sendResponse(res, false, 'Error al obtener estadÃ­sticas', null, 500);
    }
});

// ============================================
// RUTAS - DISPONIBILIDAD
// ============================================

/**
 * GET /api/horarios-disponibles - Obtener horarios disponibles
 */
app.get('/api/horarios-disponibles', async (req, res) => {
    try {
        const { fecha } = req.query;
        const date = fecha || new Date().toISOString().split('T')[0];

        // Horarios predeterminados
        const horariosDisponibles = ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:00', '14:30', '15:00', '15:30'];

        // Obtener citas existentes
        const reservados = await queryAsync(
            `SELECT TIME_FORMAT(appointment_time, '%H:%i') AS appointment_time FROM citas WHERE user_id = ? AND appointment_date = ?`,
            [req.user.id, date]
        );

        // Filtrar disponibles
        const reservadosArray = reservados.map(r => r.appointment_time);
        const disponibles = horariosDisponibles.filter(h => !reservadosArray.includes(h));

        sendResponse(res, true, 'Horarios obtenidos', disponibles);
    } catch (error) {
        console.error('Error obtener horarios:', error);
        sendResponse(res, false, 'Error al obtener horarios', null, 500);
    }
});

// ============================================
// RUTA PARA ARCHIVOS ESTÃTICOS (index.html)
// ============================================

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'API de Sistema de Agendamiento funcionando',
        version: '1.0'
    });
});

// ============================================
// MANEJO DE ERRORES
// ============================================

app.use((req, res) => {
    sendResponse(res, false, 'Ruta no encontrada', null, 404);
});

app.use((err, req, res, next) => {
    console.error('Error no manejado:', err);
    sendResponse(res, false, 'Error interno del servidor', null, 500);
});

// ============================================
// INICIAR SERVIDOR
// ============================================

async function startServer() {
    try {
        // Verificar conexion a BD
        const connected = await connectDB();
        if (!connected) {
            console.error('No se pudo conectar a la base de datos');
            process.exit(1);
        }
        await ensureDatabaseSchema();

        app.listen(PORT, () => {
            console.log(`Servidor corriendo en https://backend-ihc.onrender.com`);
            console.log(`API disponible en https://backend-ihc.onrender.com`);
            console.log(`Ejecutar setup: npm run setup\n`);
        });
    } catch (error) {
        console.error('Error iniciando servidor:', error);
        process.exit(1);
    }
}

startServer();

module.exports = app;

