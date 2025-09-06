const express = require('express');
const mysql = require('mysql2/promise');
const amqp = require('amqplib');
const axios = require('axios');
const helmet = require('helmet');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3004;

app.use(helmet());
app.use(cors());
app.use(express.json());

// Database connection
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'mysql-service',
  user: process.env.DB_USER || 'ticketuser',
  password: process.env.DB_PASSWORD || 'ticketpassword',
  database: process.env.DB_NAME || 'ticket_booking',
  connectionLimit: 10,
  reconnect: true
});

// RabbitMQ
let rabbitConnection, rabbitChannel;

async function initRabbitMQ() {
  try {
    const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://admin:password@rabbitmq-service:5672';
    rabbitConnection = await amqp.connect(rabbitmqUrl);
    rabbitChannel = await rabbitConnection.createChannel();
    
    await rabbitChannel.assertQueue('payment_processing', { durable: true });
    await rabbitChannel.assertQueue('payment_results', { durable: true });
    
    // Start consuming payment processing messages
    await rabbitChannel.consume('payment_processing', processPayment, { noAck: false });
    
    console.log('Payment service ready to process payments');
  } catch (error) {
    console.error('RabbitMQ connection failed:', error);
  }
}

// Mock payment processing function
async function processPaymentGateway(bookingId, amount, paymentMethod = 'credit_card') {
  // Simulate payment processing delay
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  // Mock success rate (90% success)
  const success = Math.random() > 0.1;
  
  if (success) {
    return {
      success: true,
      paymentId: `PAY_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`,
      transactionId: `TXN_${bookingId}_${Date.now()}`,
      amount,
      currency: 'USD',
      status: 'completed'
    };
  } else {
    return {
      success: false,
      error: 'Payment failed - insufficient funds or card declined',
      status: 'failed'
    };
  }
}

// Process payment message from queue
async function processPayment(msg) {
  if (!msg) return;
  
  const paymentData = JSON.parse(msg.content.toString());
  const { bookingId, userId, amount, bookingReference } = paymentData;
  
  console.log(`Processing payment for booking ${bookingId}, amount: ${amount}`);
  
  try {
    // Simulate payment processing
    const paymentResult = await processPaymentGateway(bookingId, amount);
    
    if (paymentResult.success) {
      // Payment successful - notify booking service
      console.log(`Payment successful for booking ${bookingId}`);
      
      await axios.post(`http://booking-service/api/bookings/${bookingId}/confirm-payment`, {
        paymentId: paymentResult.paymentId,
        paymentMethod: 'credit_card'
      });
      
      // Send success notification
      if (rabbitChannel) {
        await rabbitChannel.sendToQueue('payment_results',
          Buffer.from(JSON.stringify({
            bookingId,
            userId,
            status: 'success',
            paymentId: paymentResult.paymentId,
            amount,
            bookingReference
          })),
          { persistent: true }
        );
      }
      
    } else {
      // Payment failed
      console.log(`Payment failed for booking ${bookingId}: ${paymentResult.error}`);
      
      // Update booking to cancelled and return tickets
      await axios.post(`http://booking-service/api/bookings/${bookingId}/cancel`, {
        userId,
        reason: 'Payment failed'
      });
      
      // Send failure notification
      if (rabbitChannel) {
        await rabbitChannel.sendToQueue('payment_results',
          Buffer.from(JSON.stringify({
            bookingId,
            userId,
            status: 'failed',
            error: paymentResult.error,
            amount,
            bookingReference
          })),
          { persistent: true }
        );
      }
    }
    
    rabbitChannel.ack(msg);
    
  } catch (error) {
    console.error(`Payment processing error for booking ${bookingId}:`, error);
    
    // Requeue message for retry (up to 3 times)
    const retryCount = (msg.properties.headers && msg.properties.headers.retryCount) || 0;
    
    if (retryCount < 3) {
      setTimeout(() => {
        rabbitChannel.sendToQueue('payment_processing', msg.content, {
          persistent: true,
          headers: { retryCount: retryCount + 1 }
        });
        rabbitChannel.ack(msg);
      }, 5000 * (retryCount + 1)); // Exponential backoff
    } else {
      console.error(`Max retries exceeded for booking ${bookingId}, moving to DLQ`);
      rabbitChannel.ack(msg);
    }
  }
}

// Health checks
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', service: 'payment-service' });
});

app.get('/ready', async (req, res) => {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    
    res.status(200).json({ status: 'ready', service: 'payment-service' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: error.message });
  }
});

// Manual payment endpoint (for testing)
app.post('/api/payments/process', async (req, res) => {
  try {
    const { bookingId, amount, paymentMethod = 'credit_card' } = req.body;
    
    if (!bookingId || !amount) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    const paymentResult = await processPaymentGateway(bookingId, amount, paymentMethod);
    
    if (paymentResult.success) {
      // Record payment in database
      await pool.execute(
        'INSERT INTO payments (booking_id, amount, payment_method, payment_gateway_id, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
        [bookingId, amount, paymentMethod, paymentResult.paymentId, 'completed']
      );
      
      res.json({
        success: true,
        paymentId: paymentResult.paymentId,
        message: 'Payment processed successfully'
      });
    } else {
      res.status(400).json({
        success: false,
        error: paymentResult.error
      });
    }
    
  } catch (error) {
    console.error('Payment processing error:', error);
    res.status(500).json({ error: 'Payment processing failed' });
  }
});

// Get payment details
app.get('/api/payments/booking/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    
    const [payments] = await pool.execute(
      'SELECT * FROM payments WHERE booking_id = ? ORDER BY created_at DESC',
      [bookingId]
    );
    
    res.json(payments);
  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({ error: 'Failed to fetch payment details' });
  }
});

// Initialize RabbitMQ and start server
initRabbitMQ();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Payment service running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  if (rabbitConnection) await rabbitConnection.close();
  await pool.end();
  process.exit(0);
});

// Payment service metrics
let paymentMetrics = {
  http_requests_total: 0,
  payments_processed_total: 0,
  payments_successful_total: 0,
  payments_failed_total: 0,
  total_revenue: 0,
  start_time: Date.now()
};

// Middleware for metrics
app.use((req, res, next) => {
  paymentMetrics.http_requests_total++;
  next();
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  const uptime = (Date.now() - paymentMetrics.start_time) / 1000;
  const memUsage = process.memoryUsage();
  
  const metricsText = `# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{service="payment-service"} ${paymentMetrics.http_requests_total}

# HELP payments_processed_total Total payments processed
# TYPE payments_processed_total counter
payments_processed_total{service="payment-service"} ${paymentMetrics.payments_processed_total}

# HELP payments_successful_total Total successful payments
# TYPE payments_successful_total counter
payments_successful_total{service="payment-service"} ${paymentMetrics.payments_successful_total}

# HELP payments_failed_total Total failed payments
# TYPE payments_failed_total counter
payments_failed_total{service="payment-service"} ${paymentMetrics.payments_failed_total}

# HELP total_revenue Total revenue processed
# TYPE total_revenue gauge
total_revenue{service="payment-service"} ${paymentMetrics.total_revenue}

# HELP service_uptime_seconds Service uptime
# TYPE service_uptime_seconds gauge
service_uptime_seconds{service="payment-service"} ${uptime}

# HELP nodejs_memory_usage_bytes Memory usage
# TYPE nodejs_memory_usage_bytes gauge
nodejs_memory_usage_bytes{service="payment-service",type="rss"} ${memUsage.rss}
nodejs_memory_usage_bytes{service="payment-service",type="heapUsed"} ${memUsage.heapUsed}
`;
  
  res.set('Content-Type', 'text/plain');
  res.send(metricsText);
});
