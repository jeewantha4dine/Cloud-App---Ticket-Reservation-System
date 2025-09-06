const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql-service',
  user: process.env.DB_USER || 'ticketuser',
  password: process.env.DB_PASSWORD || 'ticketpassword',
  database: process.env.DB_NAME || 'ticket_booking',
  connectionLimit: 10,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true
});

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Metrics tracking
let metrics = {
  http_requests_total: 0,
  http_errors_total: 0,
  user_registrations_total: 0,
  user_logins_total: 0,
  active_sessions: 0,
  start_time: Date.now()
};

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    res.status(400).json({ error: 'Invalid token.' });
  }
};

// Middleware to track requests
app.use((req, res, next) => {
  metrics.http_requests_total++;
  
  if (req.path === '/api/register' && req.method === 'POST') {
    metrics.user_registrations_total++;
  }
  if (req.path === '/api/login' && req.method === 'POST') {
    metrics.user_logins_total++;
  }
  
  const originalSend = res.send;
  res.send = function(data) {
    if (res.statusCode >= 400) {
      metrics.http_errors_total++;
    }
    if (req.path === '/api/login' && res.statusCode === 200) {
      metrics.active_sessions++;
    }
    return originalSend.call(this, data);
  };
  
  next();
});

// Health check endpoints
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', service: 'user-service' });
});

app.get('/ready', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    res.status(200).json({ status: 'ready', service: 'user-service' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  const uptime = (Date.now() - metrics.start_time) / 1000;
  const memUsage = process.memoryUsage();
  
  const metricsText = `# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{service="user-service"} ${metrics.http_requests_total}

# HELP http_errors_total Total HTTP errors
# TYPE http_errors_total counter
http_errors_total{service="user-service"} ${metrics.http_errors_total}

# HELP user_registrations_total Total user registrations
# TYPE user_registrations_total counter
user_registrations_total{service="user-service"} ${metrics.user_registrations_total}

# HELP user_logins_total Total user logins
# TYPE user_logins_total counter
user_logins_total{service="user-service"} ${metrics.user_logins_total}

# HELP active_sessions Current active sessions
# TYPE active_sessions gauge
active_sessions{service="user-service"} ${metrics.active_sessions}

# HELP service_uptime_seconds Service uptime
# TYPE service_uptime_seconds gauge
service_uptime_seconds{service="user-service"} ${uptime}

# HELP nodejs_memory_usage_bytes Memory usage
# TYPE nodejs_memory_usage_bytes gauge
nodejs_memory_usage_bytes{service="user-service",type="rss"} ${memUsage.rss}
nodejs_memory_usage_bytes{service="user-service",type="heapUsed"} ${memUsage.heapUsed}
nodejs_memory_usage_bytes{service="user-service",type="heapTotal"} ${memUsage.heapTotal}
`;
  
  res.set('Content-Type', 'text/plain');
  res.send(metricsText);
});

// User registration
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, firstName, lastName, phone } = req.body;
    
    if (!email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const [result] = await pool.execute(
      'INSERT INTO users (email, password, first_name, last_name, phone, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [email, hashedPassword, firstName, lastName, phone]
    );
    
    const token = jwt.sign(
      { userId: result.insertId, email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.status(201).json({ 
      message: 'User created successfully', 
      userId: result.insertId,
      token 
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// User login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    const [users] = await pool.execute(
      'SELECT id, email, password, first_name, last_name, status FROM users WHERE email = ?',
      [email]
    );
    
    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const user = users[0];
    
    if (user.status !== 'active') {
      return res.status(401).json({ error: 'Account is inactive' });
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ 
      token, 
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get user profile
app.get('/api/profile', verifyToken, async (req, res) => {
  try {
    const [users] = await pool.execute(
      'SELECT id, email, first_name, last_name, phone, created_at FROM users WHERE id = ?',
      [req.user.userId]
    );
    
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(users[0]);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// Update user profile
app.put('/api/profile', verifyToken, async (req, res) => {
  try {
    const { firstName, lastName, phone } = req.body;
    
    await pool.execute(
      'UPDATE users SET first_name = ?, last_name = ?, phone = ?, updated_at = NOW() WHERE id = ?',
      [firstName, lastName, phone, req.user.userId]
    );
    
    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Handle 404
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`User service running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  process.exit(0);
});
