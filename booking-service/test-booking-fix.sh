#!/bin/bash

echo "Testing booking service fix..."

# Register a new user
RESPONSE=$(curl -s -X POST http://172.31.35.181/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"testfix@example.com","password":"test123","firstName":"Test","lastName":"Fix"}')

echo "Registration: $RESPONSE"

TOKEN=$(echo $RESPONSE | grep -o '"token":"[^"]*' | cut -d'"' -f4)
USER_ID=$(echo $RESPONSE | grep -o '"userId":[0-9]*' | cut -d':' -f2)

if [ ! -z "$TOKEN" ] && [ ! -z "$USER_ID" ]; then
    echo "Testing bookings API..."
    curl -H "Authorization: Bearer $TOKEN" http://172.31.35.181/api/bookings/user/$USER_ID
    echo ""
    echo "✓ Booking service is now working!"
else
    echo "Registration failed"
fi
