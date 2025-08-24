const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

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

// Redis client
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || 'redis-service',
    port: process.env.REDIS_PORT || 6379
  }
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.on('connect', () => console.log('Connected to Redis'));

// Connect to Redis
redisClient.connect().catch(console.error);

// Health check endpoints
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', service: 'event-service' });
});

app.get('/ready', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    
    await redisClient.ping();
    
    res.status(200).json({ status: 'ready', service: 'event-service' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Get all events (with caching)
app.get('/api/events', async (req, res) => {
  try {
    const { page = 1, limit = 10, status = 'active' } = req.query;
    const offset = (page - 1) * limit;
    const cacheKey = `events:${status}:${page}:${limit}`;
    
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    } catch (redisError) {
      console.log('Redis error, continuing without cache:', redisError);
    }
    
    const [events] = await pool.execute(
      'SELECT id, title, description, venue, event_date, total_tickets, available_tickets, price, status, created_at FROM events WHERE status = ? ORDER BY event_date ASC LIMIT ? OFFSET ?',
      [status, parseInt(limit), parseInt(offset)]
    );
    
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM events WHERE status = ?',
      [status]
    );
    
    const result = {
      events,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / limit)
      }
    };
    
    // Cache for 5 minutes
    try {
      await redisClient.setEx(cacheKey, 300, JSON.stringify(result));
    } catch (redisError) {
      console.log('Redis caching error:', redisError);
    }
    
    res.json(result);
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Get single event by ID
app.get('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = `event:${id}`;
    
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        return res.json(JSON.parse(cached));
      }
    } catch (redisError) {
      console.log('Redis error, continuing without cache:', redisError);
    }
    
    const [events] = await pool.execute(
      'SELECT * FROM events WHERE id = ? AND status = "active"',
      [id]
    );
    
    if (events.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = events[0];
    
    // Cache for 10 minutes
    try {
      await redisClient.setEx(cacheKey, 600, JSON.stringify(event));
    } catch (redisError) {
      console.log('Redis caching error:', redisError);
    }
    
    res.json(event);
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// Create event (admin endpoint)
app.post('/api/events', async (req, res) => {
  try {
    const { title, description, venue, eventDate, totalTickets, price } = req.body;
    
    // Validate input
    if (!title || !venue || !eventDate || !totalTickets || !price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (totalTickets <= 0 || price < 0) {
      return res.status(400).json({ error: 'Invalid ticket count or price' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO events (title, description, venue, event_date, total_tickets, available_tickets, price, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, "active", NOW())',
      [title, description, venue, eventDate, totalTickets, totalTickets, price]
    );
    
    // Invalidate cache
    try {
      const keys = await redisClient.keys('events:*');
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (redisError) {
      console.log('Redis cache invalidation error:', redisError);
    }
    
    res.status(201).json({ 
      message: 'Event created successfully', 
      eventId: result.insertId 
    });
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

// Update event
app.put('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, venue, eventDate, totalTickets, price, status } = req.body;
    
    // Check if event exists
    const [existingEvents] = await pool.execute(
      'SELECT id, available_tickets, total_tickets FROM events WHERE id = ?',
      [id]
    );
    
    if (existingEvents.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const existingEvent = existingEvents[0];
    const soldTickets = existingEvent.total_tickets - existingEvent.available_tickets;
    
    // If reducing total tickets, ensure we don't go below sold tickets
    if (totalTickets && totalTickets < soldTickets) {
      return res.status(400).json({ 
        error: `Cannot reduce total tickets below ${soldTickets} (already sold)` 
      });
    }
    
    // Calculate new available tickets
    const newAvailableTickets = totalTickets ? totalTickets - soldTickets : existingEvent.available_tickets;
    
    await pool.execute(
      `UPDATE events SET 
       title = COALESCE(?, title),
       description = COALESCE(?, description),
       venue = COALESCE(?, venue),
       event_date = COALESCE(?, event_date),
       total_tickets = COALESCE(?, total_tickets),
       available_tickets = ?,
       price = COALESCE(?, price),
       status = COALESCE(?, status),
       updated_at = NOW()
       WHERE id = ?`,
      [title, description, venue, eventDate, totalTickets, newAvailableTickets, price, status, id]
    );
    
    // Invalidate cache
    try {
      const keys = await redisClient.keys(`event*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (redisError) {
      console.log('Redis cache invalidation error:', redisError);
    }
    
    res.json({ message: 'Event updated successfully' });
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// Search events
app.get('/api/events/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    
    const searchTerm = `%${query}%`;
    
    const [events] = await pool.execute(
      'SELECT id, title, description, venue, event_date, total_tickets, available_tickets, price, status FROM events WHERE (title LIKE ? OR description LIKE ? OR venue LIKE ?) AND status = "active" ORDER BY event_date ASC LIMIT ? OFFSET ?',
      [searchTerm, searchTerm, searchTerm, parseInt(limit), parseInt(offset)]
    );
    
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM events WHERE (title LIKE ? OR description LIKE ? OR venue LIKE ?) AND status = "active"',
      [searchTerm, searchTerm, searchTerm]
    );
    
    res.json({
      events,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (error) {
    console.error('Search events error:', error);
    res.status(500).json({ error: 'Failed to search events' });
  }
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Event service running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  await redisClient.quit();
  process.exit(0);
});
