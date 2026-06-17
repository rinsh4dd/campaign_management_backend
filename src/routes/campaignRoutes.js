import { Router } from 'express';
import { handleQuery, handleAction } from '../controllers/campaignController.js';

const router = Router();

// Data Query Operations
router.post('/get', handleQuery);

// Action (Modify) Operations
router.post('/save', handleAction);

export default router;
