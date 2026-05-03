#!/bin/bash

# HomeDirect Quick Start Script

echo "🏠 HomeDirect Setup"
echo "==================="
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

echo "✅ Node.js $(node --version) detected"

# Check if PostgreSQL is installed
if ! command -v psql &> /dev/null; then
    echo "⚠️  PostgreSQL is not installed."
    echo "   For macOS: brew install postgresql"
    echo "   For Ubuntu: sudo apt install postgresql"
    echo ""
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "✅ PostgreSQL detected"
fi

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo "✅ Dependencies installed"

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo ""
    echo "📝 Creating .env file..."
    cp .env.example .env
    echo "✅ .env file created"
    echo "⚠️  Please edit .env and add your configuration:"
    echo "   - Database credentials"
    echo "   - Email settings"
    echo ""
    read -p "Press Enter to continue..."
fi

# Ask if user wants to setup database
echo ""
read -p "Do you want to setup the database now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo ""
    echo "Please enter your PostgreSQL credentials:"
    read -p "Database name [homedirect]: " DB_NAME
    DB_NAME=${DB_NAME:-homedirect}
    
    read -p "Database user [postgres]: " DB_USER
    DB_USER=${DB_USER:-postgres}
    
    echo ""
    echo "Creating database..."
    createdb $DB_NAME -U $DB_USER
    
    echo "Importing schema..."
    psql $DB_NAME -U $DB_USER < database.sql
    
    if [ $? -eq 0 ]; then
        echo "✅ Database setup complete"
    else
        echo "⚠️  Database setup had some issues. Please check the errors above."
    fi
fi

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Next steps:"
echo "1. Edit .env with your configuration"
echo "2. Start development server: npm run dev"
echo "3. Open http://localhost:3000"
echo ""
echo "For deployment instructions, see DEPLOYMENT.md"
echo ""
