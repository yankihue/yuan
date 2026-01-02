#!/bin/bash
# EC2 Setup Script for Voice-to-Code Orchestrator
# Run this on a fresh Ubuntu EC2 instance

set -e

echo "=== Voice-to-Code Orchestrator EC2 Setup ==="

# Update system
echo "Updating system packages..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
echo "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install build tools
echo "Installing build tools..."
sudo apt install -y build-essential git ffmpeg

# Install whisper.cpp
echo "Installing whisper.cpp..."
sudo mkdir -p /opt/whisper.cpp
sudo chown $USER:$USER /opt/whisper.cpp
cd /opt/whisper.cpp

git clone https://github.com/ggerganov/whisper.cpp.git .
make -j$(nproc)

# Download the base.en model (small and fast, good for English)
echo "Downloading Whisper model (base.en - 142MB)..."
./models/download-ggml-model.sh base.en

# Optionally download small.en for better accuracy (needs more RAM)
# ./models/download-ggml-model.sh small.en

echo "whisper.cpp installed at /opt/whisper.cpp"
echo "Model downloaded to /opt/whisper.cpp/models/ggml-base.en.bin"

# Install Claude Code CLI
echo "Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# Install pm2 for process management
echo "Installing pm2..."
sudo npm install -g pm2

# Create project directory
echo "Creating project directory..."
mkdir -p ~/yuan
cd ~/yuan

echo ""
echo "=== Setup Complete! ==="
echo ""
echo "Next steps:"
echo "1. Clone your repo: cd ~/yuan && git clone <your-repo-url> ."
echo "2. Install dependencies: npm install"
echo "3. Copy and edit .env: cp .env.example .env && nano .env"
echo "4. Build: npm run build"
echo "5. Start with pm2:"
echo "   pm2 start packages/orchestrator/dist/index.js --name orchestrator"
echo "   pm2 start packages/telegram-bot/dist/index.js --name telegram-bot"
echo "   pm2 save"
echo "   pm2 startup"
echo ""
echo "For local transcription, set in .env:"
echo "  TRANSCRIPTION_PROVIDER=local"
echo "  WHISPER_MODEL_PATH=/opt/whisper.cpp/models/ggml-base.en.bin"
echo "  WHISPER_BINARY_PATH=/opt/whisper.cpp/main"
