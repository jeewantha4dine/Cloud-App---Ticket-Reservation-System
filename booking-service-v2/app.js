const express = require('express');
const mysql = require('mysql2/promise');
const helmet = require('helmet');
const cors = require('cors');

const app = express();
const PORT = 3003;

app.use(helmet());
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: 'mysql-service',
  user: 'ticketuser',
  password: 'ticketpassword',
  database: 'ticket_booking',
  connectionLimit: 10
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'booking-service-v2' });
});

app.get('/ready', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// WORKING get user bookings
app.get('/api/bookings/user/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    console.log(`Getting bookings for user: ${userId}`);
    
    const [bookings] = await pool.execute(
      'SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC',
      [userId]
    );
    
    console.log(`Found ${bookings.length} bookings`);
    
    if (bookings.length === 0) {
      return res.json({ bookings: [], message: 'No bookings found' });
    }
    
    // Get event details for each booking
    const result = [];
    for (const booking of bookings) {
      try {
        const [events] = await pool.execute(
          'SELECT title, venue, event_date FROM events WHERE id = ?',
          [booking.event_id]
        );
        
        result.push({
          id: booking.id,
          booking_reference: booking.booking_reference,
          ticket_count: booking.ticket_count,
          total_amount: booking.total_amount,
          status: booking.status,
          payment_status: booking.payment_status,
          created_at: booking.created_at,
          expires_at: booking.expires_at,
          event_title: events[0]?.title || 'Unknown Event',
          venue: events[0]?.venue || 'Unknown Venue',
          event_date: events[0]?.event_date || null
        });
      } catch (err) {
        console.error('Error getting event details:', err);
        result.push({
          ...booking,
          event_title: 'Error loading event',
          venue: 'Unknown',
          event_date: null
        });
      }
    }
    
    res.json({ bookings: result });
    
  } catch (error) {
    console.error('Get bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings', details: error.message });
  }
});

// Simple booking creation
app.post('/api/bookings', async (req, res) => {
  const { userId, eventId, ticketCount } = req.body;
  
  if (!userId || !eventId || !ticketCount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  let connection = null;
  
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    
    const [events] = await connection.execute(
      'SELECT * FROM events WHERE id = ? AND status = "active"',
      [eventId]
    );
    
    if (events.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Event not found' });
    }
    
    const event = events[0];
    
    if (event.available_tickets < ticketCount) {
      await connection.rollback();
      return res.status(400).json({ error: `Only ${event.available_tickets} tickets available` });
    }
    
    const totalAmount = event.price * ticketCount;
    const bookingReference = `BK${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    
    const [result] = await connection.execute(
      'INSERT INTO bookings (user_id, event_id, ticket_count, total_amount, booking_reference, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, "pending", NOW(), DATE_ADD(NOW(), INTERVAL 15 MINUTE))',
      [userId, eventId, ticketCount, totalAmount, bookingReference]
    );
    
    await connection.execute(
      'UPDATE events SET available_tickets = available_tickets - ? WHERE id = ?',
      [ticketCount, eventId]
    );
    
    await connection.commit();
    
    res.status(201).json({
      bookingId: result.insertId,
      bookingReference,
      status: 'pending',
      totalAmount,
      ticketCount,
      eventTitle: event.title,
      message: 'Booking created successfully. Please complete payment within 15 minutes.'
    });
    
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Booking error:', error);
    res.status(500).json({ error: 'Booking failed' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Booking service v2 running on port ${PORT}`);
});

// Cancel booking endpoint
app.post('/api/bookings/:bookingId/cancel', async (req, res) => {
  const { bookingId } = req.params;
  const { userId, reason } = req.body;
  
  let connection = null;
  
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    
    // Get booking details
    const [bookings] = await connection.execute(
      'SELECT * FROM bookings WHERE id = ? AND user_id = ?',
      [bookingId, userId]
    );
    
    if (bookings.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const booking = bookings[0];
    
    if (booking.status === 'cancelled') {
      await connection.rollback();
      return res.status(400).json({ error: 'Booking already cancelled' });
    }
    
    if (booking.status === 'confirmed') {
      // Check if cancellation is allowed (e.g., at least 24 hours before event)
      const [events] = await connection.execute(
        'SELECT event_date FROM events WHERE id = ?',
        [booking.event_id]
      );
      
      const eventDate = new Date(events[0].event_date);
      const now = new Date();
      const hoursUntilEvent = (eventDate - now) / (1000 * 60 * 60);
      
      if (hoursUntilEvent < 24) {
        await connection.rollback();
        return res.status(400).json({ 
          error: 'Cannot cancel booking less than 24 hours before event' 
        });
      }
    }
    
    // Cancel booking
    await connection.execute(
      'UPDATE bookings SET status = "cancelled", updated_at = NOW() WHERE id = ?',
      [bookingId]
    );
    
    // Return tickets to available pool
    await connection.execute(
      'UPDATE events SET available_tickets = available_tickets + ? WHERE id = ?',
      [booking.ticket_count, booking.event_id]
    );
    
    await connection.commit();
    
    res.json({ 
      message: 'Booking cancelled successfully',
      bookingId,
      refundAmount: booking.payment_status === 'completed' ? booking.total_amount : 0
    });
    
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Cancel booking error:', error);
    res.status(500).json({ error: 'Failed to cancel booking' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// Booking service metrics
let bookingMetrics = {
  http_requests_total: 0,
  bookings_created_total: 0,
  bookings_cancelled_total: 0,
  booking_errors_total: 0,
  tickets_sold_total: 0,
  revenue_total: 0,
  start_time: Date.now()
};

// Middleware for metrics
app.use((req, res, next) => {
  bookingMetrics.http_requests_total++;
  
  const originalSend = res.send;
  res.send = function(data) {
    if (res.statusCode >= 400) {
      bookingMetrics.booking_errors_total++;
    }
    
    // Track successful bookings
    if (req.path === '/api/bookings' && req.method === 'POST' && res.statusCode === 201) {
      bookingMetrics.bookings_created_total++;
      try {
        const responseData = JSON.parse(data);
        if (responseData.ticketCount) {
          bookingMetrics.tickets_sold_total += responseData.ticketCount;
        }
        if (responseData.totalAmount) {
          bookingMetrics.revenue_total += parseFloat(responseData.totalAmount);
        }
      } catch (e) {}
    }
    
    return originalSend.call(this, data);
  };
  
  next();
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  const uptime = (Date.now() - bookingMetrics.start_time) / 1000;
  const memUsage = process.memoryUsage();
  
  const metricsText = `
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{service="booking-service"} ${bookingMetrics.http_requests_total}

# HELP bookings_created_total Total bookings created
# TYPE bookings_created_total counter
bookings_created_total{service="booking-service"} ${bookingMetrics.bookings_created_total}

# HELP bookings_cancelled_total Total bookings cancelled
# TYPE bookings_cancelled_total counter
bookings_cancelled_total{service="booking-service"} ${bookingMetrics.bookings_cancelled_total}

# HELP tickets_sold_total Total tickets sold
# TYPE tickets_sold_total counter
tickets_sold_total{service="booking-service"} ${bookingMetrics.tickets_sold_total}

# HELP revenue_total Total revenue generated
# TYPE revenue_total counter
revenue_total{service="booking-service"} ${bookingMetrics.revenue_total}

# HELP booking_errors_total Total booking errors
# TYPE booking_errors_total counter
booking_errors_total{service="booking-service"} ${bookingMetrics.booking_errors_total}

# HELP service_uptime_seconds Service uptime
# TYPE service_uptime_seconds gauge
service_uptime_seconds{service="booking-service"} ${uptime}

# HELP nodejs_memory_usage_bytes Memory usage
# TYPE nodejs_memory_usage_bytes gauge
nodejs_memory_usage_bytes{service="booking-service",type="rss"} ${memUsage.rss}
nodejs_memory_usage_bytes{service="booking-service",type="heapUsed"} ${memUsage.heapUsed}
`;
  
  res.set('Content-Type', 'text/plain');
  res.send(metricsText);
});
