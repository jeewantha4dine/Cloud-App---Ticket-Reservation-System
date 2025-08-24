#!/bin/bash

echo "=== Comprehensive System Test ==="

# Get ingress URL
INGRESS_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)

if [ -z "$INGRESS_IP" ]; then
  echo "Using port-forward for testing..."
  kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 8080:80 &
  PORT_FORWARD_PID=$!
  sleep 5
  BASE_URL="http://localhost:8080"
else
  BASE_URL="http://$INGRESS_IP"
fi

echo "Testing system at: $BASE_URL"

# Test 1: System Health Check
echo -e "\n1. Testing service health..."
kubectl get pods
echo ""

# Test 2: Database connectivity
echo "2. Testing database connectivity..."
kubectl run mysql-test --image=mysql:8.0 -i --rm --restart=Never -- \
  mysql -hmysql-service -uticketuser -pticketpassword ticket_booking \
  -e "SELECT COUNT(*) as event_count FROM events; SELECT COUNT(*) as user_count FROM users;"

echo -e "\n3. Testing Redis connectivity..."
kubectl run redis-test --image=redis:7-alpine -i --rm --restart=Never -- \
  redis-cli -h redis-service ping

echo -e "\n4. Testing RabbitMQ connectivity..."
kubectl run rabbitmq-test --image=curlimages/curl:latest -i --rm --restart=Never -- \
  curl -u admin:password http://rabbitmq-service:15672/api/overview

# Test 5: API endpoints
echo -e "\n5. Testing API endpoints..."

# Register user
echo "Testing user registration..."
REGISTER_RESPONSE=$(curl -s -X POST $BASE_URL/api/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "systemtest@example.com",
    "password": "testpass123",
    "firstName": "System",
    "lastName": "Test",
    "phone": "+1234567890"
  }')

echo "Register response: $REGISTER_RESPONSE"

# Extract token
TOKEN=$(echo $REGISTER_RESPONSE | grep -o '"token":"[^"]*' | cut -d'"' -f4)
USER_ID=$(echo $REGISTER_RESPONSE | grep -o '"userId":[0-9]*' | cut -d':' -f2)

if [ ! -z "$TOKEN" ]; then
  echo "✓ User registration successful"
  
  # Test events
  echo -e "\nTesting events API..."
  EVENTS_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" $BASE_URL/api/events)
  echo "Events response: $EVENTS_RESPONSE"
  
  # Test booking
  echo -e "\nTesting booking API..."
  BOOKING_RESPONSE=$(curl -s -X POST $BASE_URL/api/bookings \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{
      \"userId\": $USER_ID,
      \"eventId\": 1,
      \"ticketCount\": 2
    }")
  
  echo "Booking response: $BOOKING_RESPONSE"
  
  # Extract booking ID
  BOOKING_ID=$(echo $BOOKING_RESPONSE | grep -o '"bookingId":[0-9]*' | cut -d':' -f2)
  
  if [ ! -z "$BOOKING_ID" ]; then
    echo "✓ Booking creation successful"
    
    # Test payment simulation
    echo -e "\nTesting payment processing..."
    PAYMENT_RESPONSE=$(curl -s -X POST $BASE_URL/api/payments/process \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN" \
      -d "{
        \"bookingId\": $BOOKING_ID,
        \"amount\": 100.00,
        \"paymentMethod\": \"credit_card\"
      }")
    
    echo "Payment response: $PAYMENT_RESPONSE"
    
    # Check booking status
    echo -e "\nChecking updated booking status..."
    sleep 3
    UPDATED_BOOKING=$(curl -s -H "Authorization: Bearer $TOKEN" $BASE_URL/api/bookings/user/$USER_ID)
    echo "Updated bookings: $UPDATED_BOOKING"
  fi
else
  echo "✗ User registration failed"
fi

# Clean up port forward
if [ ! -z "$PORT_FORWARD_PID" ]; then
  kill $PORT_FORWARD_PID 2>/dev/null
fi

echo -e "\n=== Test completed ==="
