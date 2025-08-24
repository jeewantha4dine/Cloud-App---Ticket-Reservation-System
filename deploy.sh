#!/bin/bash

echo "Deploying Ticket Booking System to K3s..."

# Step 1: Deploy databases and supporting services
echo "1. Deploying MySQL..."
kubectl apply -f k8s-manifests/mysql/

echo "2. Deploying Redis..."
kubectl apply -f k8s-manifests/redis/

echo "3. Deploying RabbitMQ..."
kubectl apply -f k8s-manifests/rabbitmq/

# Wait for databases
echo "Waiting for services to be ready..."
kubectl wait --for=condition=available --timeout=300s deployment/mysql
kubectl wait --for=condition=available --timeout=120s deployment/redis
kubectl wait --for=condition=available --timeout=120s deployment/rabbitmq

# Step 2: Deploy microservices
echo "4. Deploying microservices..."
kubectl apply -f k8s-manifests/services/

# Wait for services
kubectl wait --for=condition=available --timeout=180s deployment/user-service
kubectl wait --for=condition=available --timeout=180s deployment/event-service
kubectl wait --for=condition=available --timeout=180s deployment/booking-service
kubectl wait --for=condition=available --timeout=180s deployment/payment-service

# Step 3: Deploy ingress and HPA
echo "5. Deploying API Gateway..."
kubectl apply -f k8s-manifests/ingress/

echo "6. Deploying Horizontal Pod Autoscalers..."
kubectl apply -f hpa.yaml

echo "Deployment completed!"
echo "Checking pod status..."
kubectl get pods
echo ""
echo "Checking services..."
kubectl get svc
echo ""
echo "Checking ingress..."
kubectl get ingress

echo ""
echo "System is ready! Access the application at:"
INGRESS_IP=$(kubectl get svc -n ingress-nginx ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
if [ -z "$INGRESS_IP" ]; then
  echo "http://localhost:8080 (use port-forward: kubectl port-forward -n ingress-nginx svc/ingress-nginx-controller 8080:80)"
else
  echo "http://$INGRESS_IP"
fi
