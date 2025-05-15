import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";
dotenv.config({});
import connectDB from "./database/db.js";
import userRouter from "./routes/user.routes.js";
import courseRouter from "./routes/course.route.js";
import mediaRouter from "./routes/media.route.js";
import purchaseRoute from "./routes/purchaseCourse.route.js";
import { stripeWebhook } from "./controllers/coursePurchase.controller.js";
import courseProgressRoute from "./routes/courseProgress.route.js";

connectDB();
const app = express();

const PORT = process.env.PORT || 8080;

// Configure CORS first
app.use(cors({
    origin: true, // Allow any origin
    credentials: true
}));

// IMPORTANT: The Stripe webhook route must be defined BEFORE express.json() middleware
// because Stripe needs the raw body to validate the webhook signature
app.post("/api/v1/purchase/webhook", express.raw({ type: 'application/json' }), stripeWebhook);

// AFTER the webhook route, apply JSON parsing middleware for all other routes
app.use(express.json());
app.use(cookieParser());

// API routes
app.use("/api/v1/media", mediaRouter);
app.use("/api/v1/user", userRouter);
app.use("/api/v1/course", courseRouter);
app.use("/api/v1/purchase", purchaseRoute);
app.use("/api/v1/progress", courseProgressRoute);

app.get("/home", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Hello i am coming from backend"
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Stripe webhook endpoint: http://localhost:${PORT}/api/v1/purchase/webhook`);
});
