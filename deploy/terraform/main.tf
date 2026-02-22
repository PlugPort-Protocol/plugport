# PlugPort Terraform - Cloud Deployment (Railway/Render Free Tier)
# This template provisions PlugPort on free-tier cloud services

terraform {
  required_version = ">= 1.5"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

# Variables
variable "plugport_version" {
  description = "PlugPort Docker image version"
  type        = string
  default     = "latest"
}

variable "http_port" {
  description = "HTTP API port"
  type        = number
  default     = 8080
}

variable "wire_port" {
  description = "Wire protocol port"
  type        = number
  default     = 27017
}

variable "api_key" {
  description = "API key for authentication"
  type        = string
  default     = ""
  sensitive   = true
}

variable "metrics_enabled" {
  description = "Enable Prometheus metrics endpoint"
  type        = bool
  default     = true
}

# Docker Network
resource "docker_network" "plugport_net" {
  name = "plugport-network"
}

# PlugPort Server
resource "docker_image" "plugport_server" {
  name         = "plugport/server:${var.plugport_version}"
  keep_locally = true
}

resource "docker_container" "plugport_server" {
  name  = "plugport-server"
  image = docker_image.plugport_server.image_id

  ports {
    internal = 8080
    external = var.http_port
  }

  ports {
    internal = 27017
    external = var.wire_port
  }

  env = [
    "HTTP_PORT=8080",
    "WIRE_PORT=27017",
    "LOG_LEVEL=info",
    "METRICS_ENABLED=${var.metrics_enabled}",
    "API_KEY=${var.api_key}",
  ]

  networks_advanced {
    name = docker_network.plugport_net.name
  }

  restart = "unless-stopped"

  healthcheck {
    test         = ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:8080/health"]
    interval     = "10s"
    timeout      = "5s"
    retries      = 5
    start_period = "10s"
  }
}

# PlugPort Dashboard
resource "docker_image" "plugport_dashboard" {
  name         = "plugport/dashboard:${var.plugport_version}"
  keep_locally = true
}

resource "docker_container" "plugport_dashboard" {
  name  = "plugport-dashboard"
  image = docker_image.plugport_dashboard.image_id

  ports {
    internal = 3000
    external = 3000
  }

  env = [
    "NEXT_PUBLIC_API_URL=http://plugport-server:8080",
  ]

  networks_advanced {
    name = docker_network.plugport_net.name
  }

  restart    = "unless-stopped"
  depends_on = [docker_container.plugport_server]
}

# Outputs
output "api_url" {
  value = "http://localhost:${var.http_port}"
}

output "wire_url" {
  value = "mongodb://localhost:${var.wire_port}"
}

output "dashboard_url" {
  value = "http://localhost:3000"
}
