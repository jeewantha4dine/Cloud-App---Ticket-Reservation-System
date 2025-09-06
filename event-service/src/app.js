const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3002;

app.use(helmet());
app.use(cors());
app.use(express.json());

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

const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || 'redis-service',
    port: process.env.REDIS_PORT || 6379
  }
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.connect().catch(console.error);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', service: 'event-service' });
});

app.get('/ready', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    res.status(200).json({ status: 'ready', service: 'event-service' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Simplified events endpoint - no pagination for now
app.get('/api/events', async (req, res) => {
  try {
    const status = req.query.status || 'active';
    
    // Simple query without LIMIT/OFFSET to avoid parameter issues
    const [events] = await pool.execute(
      'SELECT id, title, description, venue, event_date, total_tickets, available_tickets, price, status, created_at FROM events WHERE status = ? ORDER BY event_date ASC',
      [status]
    );
    
    const result = {
      events,
      pagination: {
        page: 1,
        limit: events.length,
        total: events.length,
        pages: 1
      }
    };
    
    res.json(result);
  } catch (error) {
    console.error('Get events error:', error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/api/events/:id', async (req, res) => {
  try {
    const eventId = req.params.id;
    
    const [events] = await pool.execute(
      'SELECT * FROM events WHERE id = ? AND status = "active"',
      [eventId]
    );
    
    if (events.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    
    res.json(events[0]);
  } catch (error) {
    console.error('Get event error:', error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

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

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  await redisClient.quit();
  process.exit(0);
});

// Event service metrics
let eventMetrics = {
  http_requests_total: 0,
  events_created_total: 0,
  events_viewed_total: 0,
  cache_hits_total: 0,
  cache_misses_total: 0,
  start_time: Date.now()
};

// Middleware for metrics (add before existing routes)
app.use((req, res, next) => {
  eventMetrics.http_requests_total++;
  
  if (req.path === '/api/events' && req.method === 'GET') {
    eventMetrics.events_viewed_total++;
  }
  if (req.path === '/api/events' && req.method === 'POST') {
    eventMetrics.events_created_total++;
  }
  
  next();
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  const uptime = (Date.now() - eventMetrics.start_time) / 1000;
  const memUsage = process.memoryUsage();
  
  const metricsText = `# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{service="event-service"} ${eventMetrics.http_requests_total}

# HELP events_created_total Total events created
# TYPE events_created_total counter
events_created_total{service="event-service"} ${eventMetrics.events_created_total}

# HELP events_viewed_total Total events viewed
# TYPE events_viewed_total counter
events_viewed_total{service="event-service"} ${eventMetrics.events_viewed_total}

# HELP cache_hits_total Total cache hits
# TYPE cache_hits_total counter
cache_hits_total{service="event-service"} ${eventMetrics.cache_hits_total}

# HELP service_uptime_seconds Service uptime
# TYPE service_uptime_seconds gauge
service_uptime_seconds{service="event-service"} ${uptime}

# HELP nodejs_memory_usage_bytes Memory usage
# TYPE nodejs_memory_usage_bytes gauge
nodejs_memory_usage_bytes{service="event-service",type="rss"} ${memUsage.rss}
nodejs_memory_usage_bytes{service="event-service",type="heapUsed"} ${memUsage.heapUsed}
`;
  
  res.set('Content-Type', 'text/plain');
  res.send(metricsText);
});
