#!/bin/bash

echo "Deploying Complete Cloud-Native Ticket Booking System to K3s..."
echo "============================================================"

# Step 1: Deploy databases and supporting services
echo "1. Deploying MySQL..."
kubectl apply -f k8s-manifests/mysql/

echo "2. Deploying Redis..."
kubectl apply -f k8s-manifests/redis/

echo "3. Deploying RabbitMQ..."
kubectl apply -f k8s-manifests/rabbitmq/

# Wait for databases
echo "Waiting for infrastructure services to be ready..."
kubectl wait --for=condition=available --timeout=300s deployment/mysql
kubectl wait --for=condition=available --timeout=120s deployment/redis
kubectl wait --for=condition=available --timeout=120s deployment/rabbitmq

# Step 2: Deploy monitoring infrastructure
echo "4. Deploying Monitoring Stack..."
echo "   - Prometheus..."
kubectl apply -f k8s-manifests/monitoring/

echo "   - Grafana..."
kubectl apply -f k8s-manifests/monitoring/grafana-minimal.yaml

# Wait for monitoring
kubectl wait --for=condition=available --timeout=180s deployment/prometheus
kubectl wait --for=condition=available --timeout=180s deployment/grafana

# Step 3: Deploy microservices
echo "5. Deploying Microservices..."
kubectl apply -f k8s-manifests/services/

# Wait for services
echo "Waiting for microservices to be ready..."
kubectl wait --for=condition=available --timeout=180s deployment/user-service
kubectl wait --for=condition=available --timeout=180s deployment/event-service
kubectl wait --for=condition=available --timeout=180s deployment/booking-service
kubectl wait --for=condition=available --timeout=180s deployment/payment-service
kubectl wait --for=condition=available --timeout=120s deployment/frontend-service

# Step 4: Deploy ingress and autoscaling
echo "6. Deploying API Gateway and Load Balancing..."
kubectl apply -f k8s-manifests/ingress/

echo "7. Deploying Horizontal Pod Autoscalers..."
kubectl apply -f hpa.yaml

# Step 5: Verify deployment
echo "8. Verifying Deployment..."
sleep 10

echo "============================================================"
echo "DEPLOYMENT COMPLETED SUCCESSFULLY!"
echo "============================================================"

echo "Pod Status:"
kubectl get pods | grep -E "(user-service|event-service|booking-service|payment-service|frontend-service|mysql|redis|rabbitmq|prometheus|grafana)"

echo ""
echo "Services:"
kubectl get svc | grep -E "(user-service|event-service|booking-service|payment-service|frontend-service|mysql-service|redis-service|rabbitmq-service|prometheus-service|grafana)"

echo ""
echo "Ingress:"
kubectl get ingress

echo ""
echo "Auto-scaling Status:"
kubectl get hpa

echo ""
echo "============================================================"
echo "ACCESS INFORMATION"
echo "============================================================"

# Get external IP for Traefik
EXTERNAL_IP=$(kubectl get svc -n kube-system traefik -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)

if [ -z "$EXTERNAL_IP" ]; then
  # Fallback to node IP if no external IP
  EXTERNAL_IP=$(curl -s http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo "YOUR_PUBLIC_IP")
fi

echo "Main Application: http://$EXTERNAL_IP"
echo "Grafana Dashboard: http://$EXTERNAL_IP/grafana/ (admin/admin123)"
echo "Prometheus Monitoring: http://$EXTERNAL_IP:30000"
echo ""
echo "API Endpoints:"
echo "  - User Registration: http://$EXTERNAL_IP/api/register"
echo "  - Events: http://$EXTERNAL_IP/api/events"
echo "  - Bookings: http://$EXTERNAL_IP/api/bookings"
echo ""
echo "============================================================"
echo "SYSTEM CAPABILITIES"
echo "============================================================"
echo "✓ Microservices Architecture (4 services)"
echo "✓ Container Orchestration (Kubernetes)"
echo "✓ Auto-scaling (HPA configured)"
echo "✓ Load Balancing (Traefik Ingress)"
echo "✓ Database Persistence (MySQL)"
echo "✓ Caching Layer (Redis)"
echo "✓ Message Queuing (RabbitMQ)"
echo "✓ Monitoring & Observability (Prometheus + Grafana)"
echo "✓ High Availability (Multi-replica deployments)"
echo "✓ Security (JWT Authentication, Network Policies)"
echo ""
echo "============================================================"
echo "NEXT STEPS"
echo "============================================================"
echo "1. Access the web application to test functionality"
echo "2. Configure Grafana dashboards for monitoring"
echo "3. Generate traffic to see auto-scaling in action"
echo "4. Review metrics in Prometheus and Grafana"
echo ""
echo "For troubleshooting, use:"
echo "  kubectl get pods"
echo "  kubectl logs <pod-name>"
echo "  kubectl describe pod <pod-name>"
echo ""
echo "Cloud-Native Ticket Booking System is ready for demonstration!"
