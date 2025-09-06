const express = require('express');
const mysql = require('mysql2/promise');
const redis = require('redis');
const amqp = require('amqplib');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3003;

app.use(helmet());
app.use(cors());
app.use(express.json());

// Database connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql-service',
  user: process.env.DB_USER || 'ticketuser',
  password: process.env.DB_PASSWORD || 'ticketpassword',
  database: process.env.DB_NAME || 'ticket_booking',
  connectionLimit: 20,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true
});

// Redis client for distributed locking
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || 'redis-service',
    port: process.env.REDIS_PORT || 6379
  }
});

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.connect().catch(console.error);

// RabbitMQ connection
let rabbitConnection, rabbitChannel;

async function initRabbitMQ() {
  try {
    const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://admin:password@rabbitmq-service:5672';
    rabbitConnection = await amqp.connect(rabbitmqUrl);
    rabbitChannel = await rabbitConnection.createChannel();
    
    // Declare queues
    await rabbitChannel.assertQueue('booking_notifications', { durable: true });
    await rabbitChannel.assertQueue('payment_processing', { durable: true });
    await rabbitChannel.assertQueue('booking_confirmations', { durable: true });
    
    console.log('RabbitMQ connected and queues declared');
  } catch (error) {
    console.error('RabbitMQ connection failed:', error);
  }
}

// Initialize RabbitMQ
initRabbitMQ();

// Health checks
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', service: 'booking-service' });
});

app.get('/ready', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    
    await redisClient.ping();
    
    res.status(200).json({ status: 'ready', service: 'booking-service' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Distributed lock helper function
async function acquireLock(key, ttl = 30) {
  try {
    const lockValue = uuidv4();
    const result = await redisClient.set(key, lockValue, {
      PX: ttl * 1000, // TTL in milliseconds
      NX: true // Only set if key doesn't exist
    });
    return result === 'OK' ? lockValue : null;
  } catch (error) {
    console.error('Lock acquisition error:', error);
    return null;
  }
}

async function releaseLock(key, lockValue) {
  try {
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await redisClient.eval(script, 1, key, lockValue);
  } catch (error) {
    console.error('Lock release error:', error);
  }
}

// Book tickets with distributed locking and race condition prevention
app.post('/api/bookings', async (req, res) => {
  const { userId, eventId, ticketCount } = req.body;
  
  // Validation
  if (!userId || !eventId || !ticketCount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  if (ticketCount <= 0 || ticketCount > 10) {
    return res.status(400).json({ error: 'Invalid ticket count (1-10 allowed)' });
  }
  
  const lockKey = `event_booking_lock:${eventId}`;
  let lockValue = null;
  let connection = null;
  
  try {
    // Acquire distributed lock
    lockValue = await acquireLock(lockKey, 30);
    
    if (!lockValue) {
      return res.status(429).json({ 
        error: 'Event is currently being booked by another user. Please try again.' 
      });
    }
    
    connection = await pool.getConnection();
    await connection.beginTransaction();
    
    // Check event exists and get current ticket availability with row lock
    const [events] = await connection.execute(
      'SELECT id, title, available_tickets, price, status, event_date FROM events WHERE id = ? AND status = "active" FOR UPDATE',
      [eventId]
    );
    
    if (events.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Event not found or inactive' });
    }
    
    const event = events[0];
    
    // Check if event is in the future
    if (new Date(event.event_date) <= new Date()) {
      await connection.rollback();
      return res.status(400).json({ error: 'Cannot book tickets for past events' });
    }
    
    // Check ticket availability
    if (event.available_tickets < ticketCount) {
      await connection.rollback();
      return res.status(400).json({ 
        error: `Only ${event.available_tickets} tickets available` 
      });
    }
    
    // Check if user already has pending booking for this event
    const [existingBookings] = await connection.execute(
      'SELECT id FROM bookings WHERE user_id = ? AND event_id = ? AND status IN ("pending", "confirmed")',
      [userId, eventId]
    );
    
    if (existingBookings.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'You already have a booking for this event' });
    }
    
    // Calculate total amount
    const totalAmount = event.price * ticketCount;
    const bookingReference = `BK${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
    
    // Create booking
    const [bookingResult] = await connection.execute(
      'INSERT INTO bookings (user_id, event_id, ticket_count, total_amount, booking_reference, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, "pending", NOW(), DATE_ADD(NOW(), INTERVAL 15 MINUTE))',
      [userId, eventId, ticketCount, totalAmount, bookingReference]
    );
    
    // Update available tickets
    await connection.execute(
      'UPDATE events SET available_tickets = available_tickets - ?, updated_at = NOW() WHERE id = ?',
      [ticketCount, eventId]
    );
    
    await connection.commit();
    
    const bookingId = bookingResult.insertId;
    
    // Send async notifications
    if (rabbitChannel) {
      try {
        // Booking notification
        await rabbitChannel.sendToQueue('booking_notifications', 
          Buffer.from(JSON.stringify({
            bookingId,
            userId,
            eventId,
            eventTitle: event.title,
            ticketCount,
            totalAmount,
            bookingReference,
            type: 'booking_created'
          })), 
          { persistent: true }
        );
        
        // Payment processing
        await rabbitChannel.sendToQueue('payment_processing',
          Buffer.from(JSON.stringify({
            bookingId,
            userId,
            amount: totalAmount,
            bookingReference
          })),
          { persistent: true }
        );
      } catch (mqError) {
        console.error('Message queue error:', mqError);
        // Don't fail the booking if MQ fails
      }
    }
    
    res.status(201).json({
      bookingId,
      bookingReference,
      status: 'pending',
      totalAmount,
      ticketCount,
      eventTitle: event.title,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      message: 'Booking created successfully. Please complete payment within 15 minutes.'
    });
    
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Booking error:', error);
    res.status(500).json({ error: 'Booking failed. Please try again.' });
  } finally {
    if (connection) {
      connection.release();
    }
    if (lockValue) {
      await releaseLock(lockKey, lockValue);
    }
  }
});

// Get user bookings
app.get('/api/bookings/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;
    
    let query = `
      SELECT b.id, b.booking_reference, b.ticket_count, b.total_amount, b.status, 
             b.payment_status, b.created_at, b.expires_at,
             e.title as event_title, e.venue, e.event_date
      FROM bookings b
      JOIN events e ON b.event_id = e.id
      WHERE b.user_id = ?
    `;
    
    const params = [userId];
    
    if (status) {
      query += ' AND b.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY b.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const [bookings] = await pool.execute(query, params);
    
    const [countResult] = await pool.execute(
      status 
        ? 'SELECT COUNT(*) as total FROM bookings WHERE user_id = ? AND status = ?'
        : 'SELECT COUNT(*) as total FROM bookings WHERE user_id = ?',
      status ? [userId, status] : [userId]
    );
    
    res.json({
      bookings,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / limit)
      }
    });
  } catch (error) {
    console.error('Get user bookings error:', error);
    res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// Get booking details
app.get('/api/bookings/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    const [bookings] = await pool.execute(`
      SELECT b.*, e.title as event_title, e.description as event_description,
             e.venue, e.event_date, u.first_name, u.last_name, u.email
      FROM bookings b
      JOIN events e ON b.event_id = e.id
      JOIN users u ON b.user_id = u.id
      WHERE b.id = ?
    `, [bookingId]);
    
    if (bookings.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    res.json(bookings[0]);
  } catch (error) {
    console.error('Get booking error:', error);
    res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// Cancel booking
app.post('/api/bookings/:bookingId/cancel', async (req, res) => {
  const { bookingId } = req.params;
  const { userId, reason } = req.body;
  
  let connection = null;
  
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    
    // Get booking details with lock
    const [bookings] = await connection.execute(
      'SELECT * FROM bookings WHERE id = ? AND user_id = ? FOR UPDATE',
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
    
    // Send notification
    if (rabbitChannel) {
      try {
        await rabbitChannel.sendToQueue('booking_notifications',
          Buffer.from(JSON.stringify({
            bookingId,
            userId,
            eventId: booking.event_id,
            type: 'booking_cancelled',
            reason: reason || 'User cancelled'
          })),
          { persistent: true }
        );
      } catch (mqError) {
        console.error('Message queue error:', mqError);
      }
    }
    
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

// Confirm payment (called by payment service)
app.post('/api/bookings/:bookingId/confirm-payment', async (req, res) => {
  const { bookingId } = req.params;
  const { paymentId, paymentMethod } = req.body;
  
  let connection = null;
  
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    
    const [bookings] = await connection.execute(
      'SELECT * FROM bookings WHERE id = ? FOR UPDATE',
      [bookingId]
    );
    
    if (bookings.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Booking not found' });
    }
    
    const booking = bookings[0];
    
    if (booking.status !== 'pending') {
      await connection.rollback();
      return res.status(400).json({ error: 'Booking is not in pending status' });
    }
    
    // Update booking status
    await connection.execute(
      'UPDATE bookings SET status = "confirmed", payment_status = "completed", updated_at = NOW() WHERE id = ?',
      [bookingId]
    );
    
    // Record payment
    await connection.execute(
      'INSERT INTO payments (booking_id, amount, payment_method, payment_gateway_id, status, created_at) VALUES (?, ?, ?, ?, "completed", NOW())',
      [bookingId, booking.total_amount, paymentMethod, paymentId]
    );
    
    await connection.commit();
    
    // Send confirmation notification
    if (rabbitChannel) {
      try {
        await rabbitChannel.sendToQueue('booking_confirmations',
          Buffer.from(JSON.stringify({
            bookingId,
            userId: booking.user_id,
            eventId: booking.event_id,
            bookingReference: booking.booking_reference,
            type: 'payment_confirmed'
          })),
          { persistent: true }
        );
      } catch (mqError) {
        console.error('Message queue error:', mqError);
      }
    }
    
    res.json({ message: 'Payment confirmed successfully' });
    
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Confirm payment error:', error);
    res.status(500).json({ error: 'Failed to confirm payment' });
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// Cleanup expired bookings (should be called by a cron job)
app.post('/api/bookings/cleanup-expired', async (req, res) => {
  let connection = null;
  
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    
    // Find expired pending bookings
    const [expiredBookings] = await connection.execute(`
      SELECT b.id, b.event_id, b.ticket_count, b.user_id
      FROM bookings b 
      WHERE b.status = 'pending' 
      AND b.expires_at < NOW()
      FOR UPDATE
    `);
    
    if (expiredBookings.length === 0) {
      await connection.rollback();
      return res.json({ message: 'No expired bookings found', count: 0 });
    }
    
    // Return tickets to available pool for each expired booking
    for (const booking of expiredBookings) {
      await connection.execute(
        'UPDATE events SET available_tickets = available_tickets + ? WHERE id = ?',
        [booking.ticket_count, booking.event_id]
      );
      
      // Send notification about expiry
      if (rabbitChannel) {
        try {
          await rabbitChannel.sendToQueue('booking_notifications',
            Buffer.from(JSON.stringify({
              bookingId: booking.id,
              userId: booking.user_id,
              eventId: booking.event_id,
              type: 'booking_expired'
            })),
            { persistent: true }
          );
        } catch (mqError) {
          console.error('Message queue error:', mqError);
        }
      }
    }
    
    // Update booking statuses to expired
    await connection.execute(`
      UPDATE bookings 
      SET status = 'expired', updated_at = NOW() 
      WHERE status = 'pending' AND expires_at < NOW()
    `);
    
    await connection.commit();
    
    res.json({ 
      message: 'Expired bookings cleaned up successfully', 
      count: expiredBookings.length 
    });
    
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error('Cleanup expired bookings error:', error);
    res.status(500).json({ error: 'Failed to cleanup expired bookings' });
  } finally {
    if (connection) {
      connection.release();
    }
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
  console.log(`Booking service running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (rabbitConnection) await rabbitConnection.close();
  await pool.end();
  await redisClient.quit();
  process.exit(0);
});
