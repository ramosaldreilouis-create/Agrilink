const express = require('express');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const app = express();
const port = Number(process.env.PORT || 3000);
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agrilink_db',
    charset: 'utf8mb4'
};
const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const sessions = new Map();
const sessionCookieName = 'agrilink_session';
const bcryptHashPattern = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'agrilink_platform.html'));
});

app.get('/healthz', (req, res) => {
    res.status(200).json({ success: true, service: 'agrilink-web' });
});

async function initializeDatabase() {
    if (!/^[a-zA-Z0-9_]+$/.test(dbConfig.database)) {
        throw new Error('DB_NAME may contain only letters, numbers, and underscores.');
    }

    const createDatabase = process.env.DB_AUTO_CREATE !== 'false';
    let adminConnection;
    try {
        adminConnection = await mysql.createConnection({
            host: dbConfig.host,
            port: dbConfig.port,
            user: dbConfig.user,
            password: dbConfig.password,
            ...(createDatabase ? {} : { database: dbConfig.database }),
            charset: 'utf8mb4',
            connectTimeout: 10000
        });

        if (createDatabase) {
            await adminConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            await adminConnection.query(`USE \`${dbConfig.database}\``);
        }

        const schemaPath = path.join(__dirname, 'init_db.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');
        const statements = schemaSql
            .replace(/--.*$/gm, '')
            .split(';')
            .map(statement => statement.trim())
            .filter(Boolean)
            .filter(statement => !/^USE\s+/i.test(statement) && !/^CREATE\s+DATABASE\s+/i.test(statement));

        for (const statement of statements) {
            if (!statement) continue;
            await adminConnection.query(statement);
        }

        const [locationColumns] = await adminConnection.query(
            `SELECT COLUMN_NAME
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'location'`,
            [dbConfig.database]
        );
        if (!locationColumns.length) {
            await adminConnection.query('ALTER TABLE users ADD COLUMN location VARCHAR(255) NULL');
        }

        console.log('Database initialized and connected successfully.');
    } catch (error) {
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            throw new Error(`Cannot connect to MySQL at ${dbConfig.host}:${dbConfig.port}. Start MySQL or check DB_HOST and DB_PORT.`);
        }
        if (error.code === 'ER_ACCESS_DENIED_ERROR') {
            throw new Error('MySQL rejected the configured credentials. Check DB_USER and DB_PASSWORD.');
        }
        if (error.code === 'ER_DBACCESS_DENIED_ERROR') {
            throw new Error(`MySQL user "${dbConfig.user}" cannot access database "${dbConfig.database}". Grant it database privileges or configure DB_USER and DB_PASSWORD.`);
        }
        throw new Error(`Database initialization failed: ${error.message}`);
    } finally {
        if (adminConnection) await adminConnection.end();
    }
}

async function startServer() {
    let db;
    let databaseReady = false;
    try {
        await initializeDatabase();
        db = mysql.createPool({
            ...dbConfig,
            connectTimeout: 10000,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        databaseReady = true;
    } catch (error) {
        console.error('AGRILINK database is unavailable; the website will still start:', error.message);
    }
    app.locals.db = db;

    function getSessionUserId(req) {
        const cookieHeader = req.headers.cookie || '';
        const sessionCookie = cookieHeader
            .split(';')
            .map(cookie => cookie.trim())
            .find(cookie => cookie.startsWith(`${sessionCookieName}=`));
        if (!sessionCookie) return null;

        const token = decodeURIComponent(sessionCookie.slice(sessionCookieName.length + 1));
        return sessions.get(token) || null;
    }

    function createSession(userId, res) {
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, userId);
        const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        res.setHeader(
            'Set-Cookie',
            `${sessionCookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`
        );
    }

    function hashPassword(password) {
        return new Promise((resolve, reject) => {
            const salt = crypto.randomBytes(16);
            crypto.scrypt(password, salt, 64, (error, derivedKey) => {
                if (error) return reject(error);
                resolve(`$scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`);
            });
        });
    }

    async function verifyPassword(password, storedHash) {
        if (typeof storedHash !== 'string') return false;

        if (bcryptHashPattern.test(storedHash)) {
            const compatibleHash = storedHash.startsWith('$2y$')
                ? `$2b$${storedHash.slice(4)}`
                : storedHash;
            return bcrypt.compare(password, compatibleHash);
        }

        const parts = storedHash.split('$');
        if (parts.length !== 4 || parts[1] !== 'scrypt') return false;

        const salt = Buffer.from(parts[2], 'hex');
        const expected = Buffer.from(parts[3], 'hex');
        if (!salt.length || expected.length !== 64) return false;

        return new Promise((resolve, reject) => {
            crypto.scrypt(password, salt, expected.length, (error, derivedKey) => {
                if (error) return reject(error);
                resolve(crypto.timingSafeEqual(derivedKey, expected));
            });
        });
    }

    app.get('/api/health', async (req, res) => {
        if (!db) {
            return res.status(503).json({
                success: false,
                error: `Database unavailable. Check MySQL at ${dbConfig.host}:${dbConfig.port}, then restart AGRILINK.`
            });
        }

        try {
            await db.query('SELECT 1');
            res.json({
                success: true,
                service: 'agrilink-account-api',
                baseUrl: `http://localhost:${port}`
            });
        } catch (error) {
            res.status(503).json({
                success: false,
                error: `Database unavailable. Check MySQL at ${dbConfig.host}:${dbConfig.port}, then restart AGRILINK.`
            });
        }
    });

    app.use('/api', (req, res, next) => {
        if (!db) {
            return res.status(503).json({
                error: `Database unavailable. Check MySQL at ${dbConfig.host}:${dbConfig.port}, then restart AGRILINK.`
            });
        }
        next();
    });

    app.get('/api/products', async (req, res) => {
        try {
            const query = req.query.q ? `%${req.query.q}%` : '%';
            const [results] = await db.query(
                'SELECT * FROM products WHERE name_en LIKE ? OR name_tl LIKE ? ORDER BY id DESC',
                [query, query]
            );
            res.json({ success: true, data: results });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/orders', async (req, res) => {
        let connection;
        let transactionStarted = false;
        try {
            const {
                buyer_id,
                hub_id,
                total_amount,
                payment_method,
                voucher_id = null,
                suki_points_used = 0,
                items = []
            } = req.body;

            if (!buyer_id || !hub_id || !Array.isArray(items) || items.length === 0) {
                return res.status(400).json({ error: 'Missing buyer_id, hub_id, or order items.' });
            }

            connection = await db.getConnection();
            await connection.beginTransaction();
            transactionStarted = true;

            const [result] = await connection.query(
                'INSERT INTO orders (buyer_id, hub_id, total_amount, voucher_id, suki_points_used, payment_method) VALUES (?, ?, ?, ?, ?, ?)',
                [buyer_id, hub_id, total_amount, voucher_id, suki_points_used, payment_method || 'gcash']
            );

            const orderId = result.insertId;
            if (items.length > 0) {
                const values = items.map(item => [orderId, item.product_id, item.quantity_kg, item.price_per_kg, item.subtotal]);
                const placeholders = values.map(() => '(?, ?, ?, ?, ?)').join(', ');
                const flatValues = values.flat();

                await connection.query(
                    `INSERT INTO order_items (order_id, product_id, quantity_kg, price_per_kg, subtotal) VALUES ${placeholders}`,
                    flatValues
                );
            }

            await connection.commit();
            transactionStarted = false;
            res.status(201).json({ success: true, orderId });
        } catch (error) {
            if (transactionStarted) {
                try {
                    await connection.rollback();
                } catch (rollbackError) {
                    console.error('Order transaction rollback failed:', rollbackError.message);
                }
            }
            console.error('Order creation failed:', error.message);
            res.status(500).json({ error: 'Unable to create order right now.' });
        } finally {
            if (connection) connection.release();
        }
    });

    app.post('/api/products', async (req, res) => {
        try {
            const { farmer_id, name_en, name_tl, category, price, farm_gate, logistics, platform, yield: expectedYield, harvest_date } = req.body;
            const [result] = await db.query(
                `INSERT INTO products (farmer_id, name_en, name_tl, category, price_per_kg, farm_gate_price, logistics_fee, platform_fee, expected_yield_kg, harvest_date)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [farmer_id, name_en, name_tl, category, price, farm_gate, logistics, platform, expectedYield, harvest_date]
            );
            res.json({ success: true, productId: result.insertId });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    app.post('/api/auth/register', async (req, res) => {
        try {
            const fullName = typeof req.body.full_name === 'string' ? req.body.full_name.trim() : '';
            const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
            const password = typeof req.body.password === 'string' ? req.body.password : '';
            const location = typeof req.body.location === 'string' ? req.body.location.trim() : '';

            if (fullName.length < 2 || fullName.length > 100) {
                return res.status(400).json({ error: 'Enter a name between 2 and 100 characters.' });
            }
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
                return res.status(400).json({ error: 'Enter a valid email address.' });
            }
            if (password.length < 8 || password.length > 128) {
                return res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
            }
            if (location.length > 255) {
                return res.status(400).json({ error: 'Location must be 255 characters or fewer.' });
            }

            const passwordHash = await hashPassword(password);
            const [result] = await db.query(
                'INSERT INTO users (full_name, email, password_hash, location, suki_points) VALUES (?, ?, ?, ?, 0)',
                [fullName, email, passwordHash, location || null]
            );
            const user = {
                id: result.insertId,
                full_name: fullName,
                email,
                location: location || null,
                suki_points: 0,
                is_admin: Boolean(adminEmail && email === adminEmail)
            };
            createSession(user.id, res);
            res.status(201).json({ success: true, user });
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ error: 'An account with this email already exists. Sign in instead.' });
            }
            console.error('Account registration failed:', error.message);
            res.status(500).json({ error: 'Unable to create your account right now.' });
        }
    });

    app.post('/api/auth/login', async (req, res) => {
        try {
            const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
            const password = typeof req.body.password === 'string' ? req.body.password : '';
            if (!email || !password) {
                return res.status(400).json({ error: 'Enter your email and password.' });
            }

            const [results] = await db.query(
                'SELECT id, full_name, email, password_hash, suki_points, location FROM users WHERE email = ? LIMIT 1',
                [email]
            );
            if (!results.length || !(await verifyPassword(password, results[0].password_hash))) {
                return res.status(401).json({ error: 'Invalid email or password.' });
            }

            if (bcryptHashPattern.test(results[0].password_hash)) {
                const upgradedHash = await hashPassword(password);
                await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [upgradedHash, results[0].id]);
            }

            const { password_hash, ...userRecord } = results[0];
            const user = {
                ...userRecord,
                is_admin: Boolean(adminEmail && userRecord.email.toLowerCase() === adminEmail)
            };
            createSession(user.id, res);
            res.json({ success: true, user });
        } catch (error) {
            console.error('Login failed:', error.message);
            res.status(500).json({ error: 'Unable to sign in right now.' });
        }
    });

    app.get('/api/account', async (req, res) => {
        try {
            const userId = getSessionUserId(req);
            if (!userId) return res.status(401).json({ error: 'Sign in to view your account.' });

            const [users] = await db.query(
                'SELECT id, full_name, email, suki_points, location, created_at FROM users WHERE id = ? LIMIT 1',
                [userId]
            );
            if (!users.length) return res.status(401).json({ error: 'Account not found. Please sign in again.' });

            const [orders] = await db.query(
                `SELECT o.id, o.total_amount, o.status, o.created_at, h.hub_name
                 FROM orders o
                 LEFT JOIN community_hubs h ON h.id = o.hub_id
                 WHERE o.buyer_id = ?
                 ORDER BY o.created_at DESC
                 LIMIT 20`,
                [userId]
            );
            res.json({
                success: true,
                user: { ...users[0], is_admin: Boolean(adminEmail && users[0].email.toLowerCase() === adminEmail) },
                orders
            });
        } catch (error) {
            console.error('Account dashboard load failed:', error.message);
            res.status(500).json({ error: 'Unable to load your account right now.' });
        }
    });

    app.put('/api/account/location', async (req, res) => {
        try {
            const userId = getSessionUserId(req);
            if (!userId) return res.status(401).json({ error: 'Sign in to update your profile.' });

            if (!req.body || typeof req.body.location !== 'string') {
                return res.status(400).json({ error: 'Enter a valid location.' });
            }
            const location = req.body.location.trim();
            if (location.length > 255) {
                return res.status(400).json({ error: 'Location must be 255 characters or fewer.' });
            }

            await db.query('UPDATE users SET location = ? WHERE id = ?', [location || null, userId]);
            res.json({ success: true, location });
        } catch (error) {
            console.error('Account location update failed:', error.message);
            res.status(500).json({ error: 'Unable to update your location right now.' });
        }
    });

    app.get('/api/admin/dashboard', async (req, res) => {
        try {
            const userId = getSessionUserId(req);
            if (!userId) return res.status(401).json({ error: 'Sign in to view the admin dashboard.' });
            if (!adminEmail) {
                return res.status(403).json({ error: 'Admin access is not configured. Set ADMIN_EMAIL and restart AGRILINK.' });
            }

            const [users] = await db.query('SELECT email FROM users WHERE id = ? LIMIT 1', [userId]);
            if (!users.length || users[0].email.toLowerCase() !== adminEmail) {
                return res.status(403).json({ error: 'You do not have permission to view the admin dashboard.' });
            }

            const [[stats]] = await db.query(
                `SELECT
                    (SELECT COUNT(*) FROM users) AS total_users,
                    (SELECT COUNT(*) FROM products) AS total_products,
                    (SELECT COUNT(*) FROM community_hubs) AS total_hubs,
                    COUNT(o.id) AS total_orders,
                    COALESCE(SUM(o.total_amount), 0) AS total_revenue
                 FROM orders o`
            );
            const [orders] = await db.query(
                `SELECT o.id, o.total_amount, o.status, o.created_at, u.full_name AS buyer_name, h.hub_name
                 FROM orders o
                 LEFT JOIN users u ON u.id = o.buyer_id
                 LEFT JOIN community_hubs h ON h.id = o.hub_id
                 ORDER BY o.created_at DESC
                 LIMIT 10`
            );
            const [products] = await db.query(
                `SELECT p.id, p.name_en, p.category, p.price_per_kg, p.expected_yield_kg, p.status, u.full_name AS farmer_name
                 FROM products p
                 LEFT JOIN users u ON u.id = p.farmer_id
                 ORDER BY p.created_at DESC
                 LIMIT 10`
            );

            res.json({ success: true, stats, orders, products });
        } catch (error) {
            console.error('Admin dashboard load failed:', error.message);
            res.status(500).json({ error: 'Unable to load the admin dashboard right now.' });
        }
    });

    app.post('/api/auth/logout', (req, res) => {
        const cookieHeader = req.headers.cookie || '';
        const sessionCookie = cookieHeader
            .split(';')
            .map(cookie => cookie.trim())
            .find(cookie => cookie.startsWith(`${sessionCookieName}=`));
        if (sessionCookie) {
            const token = decodeURIComponent(sessionCookie.slice(sessionCookieName.length + 1));
            sessions.delete(token);
        }
        res.setHeader('Set-Cookie', `${sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
        res.json({ success: true });
    });

    const server = app.listen(port, () => {
        console.log(`AGRILINK website running at http://localhost:${port}`);
        if (databaseReady) {
            console.log('AGRILINK database and account API are ready.');
        } else {
            console.error('AGRILINK account and database features are unavailable until MySQL is configured and the server is restarted.');
        }
    });
    server.on('error', error => {
        if (error.code === 'EADDRINUSE') {
            console.error(`Port ${port} is already in use. Stop the other service or set PORT to a free port.`);
        } else {
            console.error('AGRILINK HTTP server failed to start:', error.message);
        }
        if (!db) {
            process.exitCode = 1;
            return;
        }
        db.end().then(
            () => { process.exitCode = 1; },
            closeError => {
                console.error('Could not close the database connection:', closeError.message);
                process.exitCode = 1;
            }
        );
    });
}

startServer().catch(error => {
    console.error(`AGRILINK server failed to start: ${error.message}`);
    process.exitCode = 1;
});
