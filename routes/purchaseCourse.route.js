import express from "express";
import isAuthenticated from "../middleware/isAuthenticated.js";
import isInstructor from "../middleware/isInstructor.js";
import { createCheckoutSession, getAllPurchasedCourse, getCourseDetailWithPurchaseStatus, getInstructorSalesData, getPendingPurchases, stripeWebhook } from "../controllers/coursePurchase.controller.js";
import { CoursePurchase } from "../models/coursePurchase.model.js";

const router = express.Router();

router.route("/checkout/create-checkout-session").post(isAuthenticated, createCheckoutSession);
router.route("/courses/:courseId/detail-with-status").get(isAuthenticated,getCourseDetailWithPurchaseStatus);

router.route("/").get(isAuthenticated,getAllPurchasedCourse);
router.route("/pending").get(isAuthenticated, getPendingPurchases);

// New route for instructor sales data - protect with isInstructor middleware
router.route("/instructor/sales").get(isAuthenticated, isInstructor, getInstructorSalesData);

// Special administrative route to fix stuck payments
// Only available in development environment
router.route("/fix-payment/:purchaseId").get(async (req, res) => {
  try {
    // Only allow in development
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ message: "Not available in production" });
    }
    
    const { purchaseId } = req.params;
    
    // Find the purchase
    const purchase = await CoursePurchase.findById(purchaseId);
    
    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }
    
    // Update to succeeded
    if (purchase.status === "pending") {
      purchase.status = "succeeded";
      await purchase.save();
      
      console.log(`📝 Manually updated purchase ${purchaseId} status to succeeded`);
      return res.status(200).json({ 
        message: "Purchase updated successfully", 
        purchase 
      });
    } else {
      return res.status(400).json({ 
        message: `Purchase is already in ${purchase.status} status`,
        purchase
      });
    }
  } catch (error) {
    console.error("Error fixing payment:", error);
    return res.status(500).json({ message: "Server error" });
  }
});

export default router;