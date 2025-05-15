import mongoose from "mongoose";
import dotenv from "dotenv";
import { CoursePurchase } from "./models/coursePurchase.model.js";
import { Course } from "./models/course.model.js";
import User from "./models/user.model.js";
import Stripe from "stripe";

// Load environment variables
dotenv.config();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function fixAllStuckPayments() {
  try {
    // Connect to MongoDB
    console.log("Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("Connected to MongoDB");

    // Find all pending payments
    console.log("Looking for stuck pending payments...");
    const pendingPayments = await CoursePurchase.find({ status: "pending" }).populate("courseId");
    
    if (!pendingPayments || pendingPayments.length === 0) {
      console.log("✅ No pending payments found. Everything looks good!");
      process.exit(0);
    }

    console.log(`Found ${pendingPayments.length} pending payments to check`);
    
    let fixedCount = 0;
    let stillPendingCount = 0;
    let errorCount = 0;

    // Process each payment individually
    for (const purchase of pendingPayments) {
      try {
        console.log(`\n📦 Processing payment: ${purchase._id}`);
        console.log("Payment details:", {
          courseId: purchase.courseId?._id || purchase.courseId,
          userId: purchase.userId,
          amount: purchase.amount,
          status: purchase.status,
          paymentId: purchase.paymentId,
          createdAt: purchase.createdAt
        });

        // Check if this payment is older than 1 hour
        const isOld = (new Date() - purchase.createdAt) > (60 * 60 * 1000); // 1 hour in milliseconds
        
        // Try to verify with Stripe if possible
        let stripeVerified = false;
        if (purchase.paymentId && purchase.paymentId.startsWith('cs_')) {
          try {
            console.log(`Checking payment status with Stripe...`);
            const session = await stripe.checkout.sessions.retrieve(purchase.paymentId);
            console.log(`Stripe status for ${purchase.paymentId}: ${session.payment_status}`);
            
            if (session.payment_status === 'paid') {
              console.log(`✅ Stripe confirms this payment is PAID`);
              stripeVerified = true;
            }
          } catch (stripeError) {
            console.log(`❌ Stripe verification failed: ${stripeError.message}`);
          }
        }

        // Fix the payment if:
        // 1. Stripe confirms it's paid, OR
        // 2. It's an old pending payment (more than 1 hour)
        if (stripeVerified || isOld) {
          // Update the payment status to succeeded
          console.log(`Updating payment ${purchase._id} status to "succeeded"`);
          purchase.status = "succeeded";
          await purchase.save();
          
          // Update user enrollments
          try {
            console.log("Updating user enrollments...");
            const userUpdateResult = await User.findByIdAndUpdate(
              purchase.userId,
              { $addToSet: { enrolledCourses: purchase.courseId._id } }
            );
            console.log(`User updated: ${!!userUpdateResult}`);
          } catch (enrollError) {
            console.error("Error updating user enrollments:", enrollError.message);
          }

          // Update course enrollments
          try {
            console.log("Updating course enrollments...");
            const courseUpdateResult = await Course.findByIdAndUpdate(
              purchase.courseId._id,
              { $addToSet: { enrolledStudents: purchase.userId } }
            );
            console.log(`Course updated: ${!!courseUpdateResult}`);
          } catch (enrollError) {
            console.error("Error updating course enrollments:", enrollError.message);
          }
          
          console.log(`✅ Successfully fixed payment ${purchase._id}`);
          fixedCount++;
        } else {
          console.log(`⏳ Payment ${purchase._id} still pending, not old enough to force fix`);
          stillPendingCount++;
        }
      } catch (purchaseError) {
        console.error(`Error processing payment ${purchase._id}:`, purchaseError);
        errorCount++;
      }
    }
    
    console.log("\n📊 Summary:");
    console.log(`Total pending payments found: ${pendingPayments.length}`);
    console.log(`Fixed payments: ${fixedCount}`);
    console.log(`Still pending (not old enough): ${stillPendingCount}`);
    console.log(`Errors during processing: ${errorCount}`);
    console.log("\n✅ Payment fix process completed!");

  } catch (error) {
    console.error("Error fixing payments:", error);
  } finally {
    // Close MongoDB connection
    mongoose.connection.close();
    console.log("MongoDB connection closed");
    process.exit(0);
  }
}

// Run the function
fixAllStuckPayments(); 