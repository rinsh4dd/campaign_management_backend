import express from 'express';
import dotenv from 'dotenv';
import campaignRoutes from './routes/campaignRoutes.js';
import authRoutes from './routes/authRoutes.js';
import { requireAuth } from './middleware/authMiddleware.js';
import { initDb } from './config/db.js';
import { startScheduler } from './services/schedulerService.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware for parsing JSON requests
app.use(express.json());

// Public auth routes
app.use('/api/auth', authRoutes);

// Protected routes
app.use('/api/campaigns', requireAuth, campaignRoutes);

// Simple health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: "UP", 
    timestamp: new Date().toISOString(), 
    databaseMode: process.env.DB_MOCK === 'true' ? 'MOCK' : 'DATABASE' 
  });
});

// Centralized error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled application error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Bootstrap application
const bootstrap = async () => {
  try {
    // 1. Initialize databases, connection pools, and schemas
    await initDb();

    // 2. Start background campaign checks
    startScheduler();

    // 3. Start the Express HTTP listener
    app.listen(PORT, () => {
      console.log(`================================================================`);
      console.log(`🚀 Sharaco Campaign Scheduler Service initialized on port ${PORT}`);
      console.log(`👉 Health check: http://localhost:${PORT}/health`);
      console.log(`👉 API Campaigns Base: http://localhost:${PORT}/api/campaigns`);
      console.log(`================================================================`);
    });
  } catch (error) {
    console.error("Application bootstrap failed:", error);
    process.exit(1);
  }
};

bootstrap();
