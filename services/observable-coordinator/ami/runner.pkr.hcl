packer {
  required_version = "= 1.16.0"

  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "= 1.8.2"
    }
  }
}

variable "region" {
  type = string
  validation {
    condition     = can(regex("^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$", var.region))
    error_message = "Region must be one exact AWS region."
  }
}

variable "source_ami_id" {
  type = string
  validation {
    condition     = can(regex("^ami-[0-9a-f]{17}$", var.source_ami_id))
    error_message = "Source AMI ID must be one exact AMI ID."
  }
}

variable "subnet_id" {
  type = string
  validation {
    condition     = can(regex("^subnet-[0-9a-f]{17}$", var.subnet_id))
    error_message = "Subnet ID must be one exact subnet ID."
  }
}

variable "security_group_id" {
  type = string
  validation {
    condition     = can(regex("^sg-[0-9a-f]{17}$", var.security_group_id))
    error_message = "Security group ID must be one exact security-group ID."
  }
}

variable "kms_key_arn" {
  type = string
  validation {
    condition = can(regex(
      "^arn:(aws|aws-us-gov):kms:[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*:[0-9]{12}:key/[0-9a-f-]{36}$",
      var.kms_key_arn
    ))
    error_message = "KMS key ARN must be one exact KMS key ARN."
  }
}

variable "release_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{14}-[0-9a-f]{12}$", var.release_id))
    error_message = "Release ID must be YYYYMMDDhhmmss plus a 12-hex source revision."
  }
}

variable "coordinator_archive_path" {
  type = string
}

variable "coordinator_archive_sha256" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.coordinator_archive_sha256))
    error_message = "Coordinator archive SHA-256 must be lowercase SHA-256."
  }
}

variable "node_archive_path" {
  type = string
}

variable "node_archive_sha256" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.node_archive_sha256))
    error_message = "Node archive SHA-256 must be lowercase SHA-256."
  }
}

variable "cloudwatch_agent_package_path" {
  type = string
}

variable "cloudwatch_agent_package_sha256" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.cloudwatch_agent_package_sha256))
    error_message = "CloudWatch Agent package SHA-256 must be lowercase SHA-256."
  }
}

variable "compiler_oci_archive_path" {
  type = string
}

variable "compiler_oci_archive_sha256" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.compiler_oci_archive_sha256))
    error_message = "Compiler OCI archive SHA-256 must be lowercase SHA-256."
  }
}

variable "compiler_image_digest" {
  type = string
  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.compiler_image_digest))
    error_message = "Compiler image digest must be one exact SHA-256 image ID."
  }
}

variable "trivy_binary_path" {
  type = string
}

variable "trivy_binary_sha256" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.trivy_binary_sha256))
    error_message = "Trivy binary SHA-256 must be lowercase SHA-256."
  }
}

variable "trivy_cache_archive_path" {
  type = string
}

variable "trivy_cache_archive_sha256" {
  type = string
  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.trivy_cache_archive_sha256))
    error_message = "Trivy cache archive SHA-256 must be lowercase SHA-256."
  }
}

variable "packer_manifest_path" {
  type    = string
  default = "build/packer-manifest.json"
}

variable "host_sbom_path" {
  type    = string
  default = "build/host-sbom.cdx.json"
}

variable "host_vulnerability_report_path" {
  type    = string
  default = "build/host-vulnerabilities.json"
}

variable "compiler_sbom_path" {
  type    = string
  default = "build/compiler-sbom.cdx.json"
}

variable "compiler_vulnerability_report_path" {
  type    = string
  default = "build/compiler-vulnerabilities.json"
}

variable "vulnerability_gate_report_path" {
  type    = string
  default = "build/vulnerability-gate.json"
}

source "amazon-ebs" "observable_coordinator_arm64" {
  region                      = var.region
  source_ami                  = var.source_ami_id
  instance_type               = "t4g.large"
  ssh_username                = "ubuntu"
  ssh_interface               = "private_ip"
  subnet_id                   = var.subnet_id
  security_group_id           = var.security_group_id
  associate_public_ip_address = false
  ami_name                    = "opengeo-observable-coordinator-arm64-${var.release_id}"
  ami_description             = "OpenGeo trusted rootless Observable coordinator ${var.release_id}"
  imds_support                = "v2.0"
  ssh_clear_authorized_keys   = true
  encrypt_boot                = true
  kms_key_id                  = var.kms_key_arn

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_type           = "gp3"
    volume_size           = 40
    delete_on_termination = true
    encrypted             = true
    kms_key_id            = var.kms_key_arn
  }

  run_tags = {
    Application = "OpenGeo"
    Component   = "observable-coordinator-ami-build"
    ManagedBy   = "packer"
    Release     = var.release_id
  }

  tags = {
    Application         = "OpenGeo"
    Component           = "observable-coordinator"
    Architecture        = "arm64"
    ManagedBy           = "packer"
    Release             = var.release_id
    SourceAmiId         = var.source_ami_id
    CompilerImageDigest = var.compiler_image_digest
  }
}

build {
  name    = "opengeo-observable-coordinator-arm64"
  sources = ["source.amazon-ebs.observable_coordinator_arm64"]

  provisioner "file" {
    source      = var.coordinator_archive_path
    destination = "/tmp/opengeo-observable-coordinator.tar"
  }

  provisioner "file" {
    source      = var.node_archive_path
    destination = "/tmp/opengeo-node-arm64.tar.xz"
  }

  provisioner "file" {
    source      = var.cloudwatch_agent_package_path
    destination = "/tmp/amazon-cloudwatch-agent.deb"
  }

  provisioner "file" {
    source      = var.compiler_oci_archive_path
    destination = "/tmp/opengeo-observable-compiler.oci.tar"
  }

  provisioner "file" {
    source      = var.trivy_binary_path
    destination = "/tmp/trivy"
  }

  provisioner "file" {
    source      = var.trivy_cache_archive_path
    destination = "/tmp/trivy-cache.tar"
  }

  provisioner "file" {
    source      = "${path.root}/assets/opengeo-observable-coordinator.service"
    destination = "/tmp/opengeo-observable-coordinator.service"
  }

  provisioner "file" {
    source      = "${path.root}/assets/opengeo-observable-logrotate"
    destination = "/tmp/opengeo-observable-logrotate"
  }

  provisioner "shell" {
    script = "${path.root}/scripts/install-runner.sh"
    environment_vars = [
      "SOURCE_AMI_ID=${var.source_ami_id}",
      "RELEASE_ID=${var.release_id}",
      "COORDINATOR_ARCHIVE_SHA256=${var.coordinator_archive_sha256}",
      "NODE_ARCHIVE_SHA256=${var.node_archive_sha256}",
      "CLOUDWATCH_AGENT_PACKAGE_SHA256=${var.cloudwatch_agent_package_sha256}",
      "COMPILER_OCI_ARCHIVE_SHA256=${var.compiler_oci_archive_sha256}",
      "COMPILER_IMAGE_DIGEST=${var.compiler_image_digest}",
      "TRIVY_BINARY_SHA256=${var.trivy_binary_sha256}",
      "TRIVY_CACHE_ARCHIVE_SHA256=${var.trivy_cache_archive_sha256}"
    ]
    execute_command = "chmod +x '{{ .Path }}'; sudo -E {{ .Vars }} bash '{{ .Path }}'"
    timeout         = "30m"
  }

  provisioner "file" {
    direction   = "download"
    source      = "/opt/opengeo/host-sbom.cdx.json"
    destination = var.host_sbom_path
  }

  provisioner "file" {
    direction   = "download"
    source      = "/opt/opengeo/host-vulnerabilities.json"
    destination = var.host_vulnerability_report_path
  }

  provisioner "file" {
    direction   = "download"
    source      = "/opt/opengeo/compiler-sbom.cdx.json"
    destination = var.compiler_sbom_path
  }

  provisioner "file" {
    direction   = "download"
    source      = "/opt/opengeo/compiler-vulnerabilities.json"
    destination = var.compiler_vulnerability_report_path
  }

  provisioner "file" {
    direction   = "download"
    source      = "/opt/opengeo/vulnerability-gate.json"
    destination = var.vulnerability_gate_report_path
  }

  provisioner "shell" {
    inline = [
      "jq -e '.criticalVulnerabilityCount == 0 and .highVulnerabilityCount == 0' /opt/opengeo/vulnerability-gate.json >/dev/null"
    ]
    execute_command = "{{ .Vars }} bash '{{ .Path }}'"
  }

  post-processor "manifest" {
    output     = var.packer_manifest_path
    strip_path = true
    custom_data = {
      architecture                    = "arm64"
      source_ami_id                   = var.source_ami_id
      release_id                      = var.release_id
      coordinator_archive_sha256      = var.coordinator_archive_sha256
      node_archive_sha256             = var.node_archive_sha256
      cloudwatch_agent_package_sha256 = var.cloudwatch_agent_package_sha256
      compiler_oci_archive_sha256     = var.compiler_oci_archive_sha256
      compiler_image_digest           = var.compiler_image_digest
      trivy_binary_sha256             = var.trivy_binary_sha256
      trivy_cache_archive_sha256      = var.trivy_cache_archive_sha256
      packer_version                  = "1.16.0"
      packer_amazon_plugin_version    = "1.8.2"
    }
  }
}
