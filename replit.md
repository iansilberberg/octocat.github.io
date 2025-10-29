# Overview

This is a web application that integrates with Google's Gemini AI to provide image generation capabilities. The project is called "QTI — ¿Qué Te Imaginás?" (What Do You Imagine?), suggesting a Spanish-language creative image generation tool. It's built as a lightweight Node.js web server that serves a static frontend and provides API endpoints for AI-powered image generation.

# Recent Changes

**October 13, 2025 - Bug Fixes**
- Fixed server port from 8787 to 5000 (required for Replit deployment)
- Added API key validation at startup to prevent runtime errors when GEMINI_API_KEY is missing
- Added error handling for file system operations to prevent server crashes
- Extended MIME type support to include GIF, BMP, and SVG image formats
- Removed references to missing video poster images in HTML
- Configured workflow to run server on correct port
- Added catch-all route to support SPA navigation (fixes "Cannot GET" errors when opening links in new tabs)

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture

**Single Page Application (SPA) Pattern**
- Static HTML served from `/public` directory
- Vanilla JavaScript (no framework dependencies in package.json)
- Custom CSS with CSS variables for theming
- Fixed navigation header with responsive design using CSS Grid
- Design system based on dark theme with custom color palette (accent colors: #ff2b4f and #29f0ff)

**Rationale**: Keeps the frontend lightweight and fast without framework overhead, suitable for a focused image generation tool.

## Backend Architecture

**Express.js REST API Server**
- ES Modules (`"type": "module"` in package.json)
- Single server file architecture (`server.js`)
- Static file serving from `/public` directory
- File system-based output storage in `/public/outputs`
- CORS enabled for cross-origin requests
- JSON payload limit set to 25MB to handle base64-encoded images

**Key Design Decisions**:
- Uses ES6 imports instead of CommonJS for modern JavaScript syntax
- Combines API server and static file server in single Express instance for simplicity
- Stores generated images in public directory for direct HTTP access
- Implements data URL parsing to handle both raw base64 and data URL formats

**Pros**: Simple deployment, minimal configuration, easy to understand
**Cons**: Not suitable for high-scale production without additional infrastructure

## Data Storage

**File System Storage**
- Generated images saved to `/public/outputs` directory
- No database implementation
- Uses crypto module for generating unique filenames
- Creates directories recursively if they don't exist

**Rationale**: For an image generation tool, file system storage is sufficient for MVP. Direct file access allows simple HTTP URLs for generated images without database overhead.

**Alternatives Considered**: Could add database for metadata tracking, user sessions, or image history, but not implemented in current version.

## Authentication & Authorization

**No Authentication Layer**
- API endpoints are publicly accessible
- API key for Gemini is server-side only (environment variable)

**Security Considerations**: 
- Client cannot access GEMINI_API_KEY (server-side only)
- Application terminates if API key is not configured
- No rate limiting implemented (potential concern for production)

# External Dependencies

## AI Services

**Google Gemini AI (@google/genai v0.3.0)**
- Model: `gemini-2.5-flash-image`
- Uses `GoogleGenAI` client with API key authentication
- Supports image modality for generation
- Requires `GEMINI_API_KEY` environment variable

**Integration Pattern**:
- API key configured via `dotenv` package
- Client initialized once at server startup
- Handles both base64 and data URL image formats
- Supports multiple image formats (JPEG, PNG, WebP, GIF, BMP, SVG)

## Core Dependencies

**Express.js (v4.19.2)**
- Web server framework
- Serves static files and API endpoints
- Middleware: CORS, JSON body parser

**CORS (v2.8.5)**
- Enables cross-origin requests
- No configuration specified (allows all origins by default)

**Dotenv (v16.4.5)**
- Environment variable management
- Loads `.env` file for API keys and configuration

**Node.js Built-in Modules**
- `fs`: File system operations for saving generated images
- `path`: Path manipulation for directory structure
- `crypto`: Generating unique filenames for outputs

## Runtime Requirements

- Node.js >= 18.0.0 (required by @google/genai)
- Environment variable: `GEMINI_API_KEY` (mandatory)