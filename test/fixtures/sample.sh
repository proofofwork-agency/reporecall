#!/bin/bash

# Deploy a service to production
deploy() {
    local service="$1"
    local version="$2"

    echo "Deploying ${service} v${version}..."
    docker build -t "${service}:${version}" .
    docker push "${service}:${version}"
}

cleanup() {
    echo "Cleaning up temporary files..."
    rm -rf /tmp/build-*
    docker image prune -f
}

check_health() {
    local url="$1"
    local retries=5

    for i in $(seq 1 $retries); do
        if curl -sf "$url/health" > /dev/null; then
            echo "Service is healthy"
            return 0
        fi
        sleep 2
    done

    echo "Health check failed"
    return 1
}
