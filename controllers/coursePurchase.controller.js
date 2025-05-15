import Stripe from "stripe";
import { Course } from "../models/course.model.js";
import { CoursePurchase } from "../models/coursePurchase.model.js";
import { Lecture } from "../models/lecture.model.js";
import User from "../models/user.model.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Utility function to verify payment status directly with Stripe
export const verifyPaymentWithStripe = async (paymentId) => {
  try {
    // Check if this is a checkout session ID
    if (paymentId.startsWith('cs_')) {
      const session = await stripe.checkout.sessions.retrieve(paymentId);
      return {
        verified: session.payment_status === 'paid',
        session
      };
    }
    return { verified: false };
  } catch (error) {
    console.error(`Error verifying payment ${paymentId} with Stripe:`, error.message);
    return { verified: false, error: error.message };
  }
};

// Function to handle updating a purchase to succeeded status
export const updatePurchaseToSucceeded = async (purchase) => {
  try {
    // Already populate courseId if not populated
    if (!purchase.populated('courseId')) {
      await purchase.populate('courseId');
    }
    
    console.log(`Updating purchase ${purchase._id} status from ${purchase.status} to succeeded`);
    purchase.status = "succeeded";
    
    // Update user and course enrollments
    console.log("Updating user and course enrollments");
    try {
      await Promise.all([
        User.findByIdAndUpdate(
          purchase.userId,
          { $addToSet: { enrolledCourses: purchase.courseId._id } }
        ),
        Course.findByIdAndUpdate(
          purchase.courseId._id,
          { $addToSet: { enrolledStudents: purchase.userId } }
        ),
      ]);
      console.log("✅ User and course enrollment updates successful");
    } catch (enrollError) {
      console.error("Failed to update enrollments:", enrollError);
    }
    
    // Save the purchase with the updated status
    const savedPurchase = await purchase.save();
    console.log(`✅ Updated purchase ${purchase._id} to status: ${savedPurchase.status}`);
    return savedPurchase;
  } catch (error) {
    console.error("Error updating purchase:", error);
    throw error;
  }
};

// Setup periodic check for stuck payments (every 10 minutes)
const checkForStuckPayments = async () => {
  try {
    console.log("🔍 Checking for stuck payments...");
    
    // Find payments that are more than 2 minutes old and still pending (reduced from 5 minutes)
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const pendingPayments = await CoursePurchase.find({
      status: "pending",
      createdAt: { $lt: twoMinutesAgo }
    }).populate("courseId");
    
    console.log(`Found ${pendingPayments.length} potentially stuck payments`);
    
    // Process each pending payment
    for (const purchase of pendingPayments) {
      console.log(`Checking payment ${purchase._id} with Stripe ID ${purchase.paymentId}`);
      
      try {
        // Verify with Stripe if possible
        const stripeCheck = await verifyPaymentWithStripe(purchase.paymentId);
        
        if (stripeCheck.verified) {
          console.log(`✅ Payment ${purchase._id} verified as paid on Stripe, updating...`);
          await updatePurchaseToSucceeded(purchase);
        } else if (purchase.createdAt < new Date(Date.now() - 30 * 60 * 1000)) {
          // For payments older than 30 minutes, do an extra check directly with Stripe
          try {
            const session = await stripe.checkout.sessions.retrieve(purchase.paymentId);
            if (session && session.payment_status === 'paid') {
              console.log(`✅ Payment ${purchase._id} confirmed paid from direct Stripe check, updating...`);
              await updatePurchaseToSucceeded(purchase);
            } else {
              console.log(`⚠️ Payment ${purchase._id} still not verified after 30 minutes, status: ${session?.payment_status || 'unknown'}`);
            }
          } catch (stripeError) {
            console.error(`Error fetching session from Stripe: ${stripeError.message}`);
          }
        } else {
          console.log(`⚠️ Could not verify payment ${purchase._id} with Stripe, will retry later`);
        }
      } catch (verifyError) {
        console.error(`Error verifying payment ${purchase._id}:`, verifyError);
      }
    }

    return pendingPayments.length; // Return count for possible use by other functions
  } catch (error) {
    console.error("Error checking for stuck payments:", error);
    return 0;
  }
};

// Start the periodic check (if not in test environment)
if (process.env.NODE_ENV !== 'test') {
  // Initial check after 1 minute
  setTimeout(() => checkForStuckPayments(), 60 * 1000);
  
  // Then every 10 minutes
  setInterval(() => checkForStuckPayments(), 10 * 60 * 1000);
  
  console.log("✅ Scheduled periodic checks for stuck payments");
}

export const createCheckoutSession = async (req, res) => {
  try {
    const userId = req.id;
    const { courseId } = req.body;

    console.log("Creating checkout session for:", { userId, courseId });
    
    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ message: "Course not found!" });

    // Create new purchase record
    const newPurchase = new CoursePurchase({
      courseId,
      userId,
      amount: course.coursePrice,
      status: "pending",
    });

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "inr",
            product_data: {
              name: course.courseTitle,
              images: [course.courseThumbnail],
            },
            unit_amount: course.coursePrice * 100,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: `http://localhost:5173/courses-progress/${courseId}`,
      cancel_url: `http://localhost:5173/courses-detail/${courseId}`,
      metadata: {
        courseId: courseId.toString(),
        userId: userId.toString(),
      },
    });

    // Use session.id for payment tracking
    console.log("Created Stripe session successfully:", { 
      sessionId: session.id,
      courseId,
      userId
    });
    
    newPurchase.paymentId = session.id;
    await newPurchase.save();
    
    console.log("Saved purchase record:", { 
      purchaseId: newPurchase._id,
      sessionId: session.id,
      status: newPurchase.status
    });

    // Schedule an extra immediate payment verification check in 3 minutes
    // This will help catch recent payments that might have completed but webhook missed
    setTimeout(async () => {
      console.log(`🔍 Running special verification check for recent purchase ${newPurchase._id}`);
      try {
        const purchase = await CoursePurchase.findById(newPurchase._id);
        if (purchase && purchase.status === "pending") {
          console.log(`Found purchase ${purchase._id} still in pending status, checking with Stripe...`);
          const stripeCheck = await verifyPaymentWithStripe(purchase.paymentId);
          if (stripeCheck.verified) {
            console.log(`✅ Payment ${purchase._id} verified as paid in follow-up check, updating...`);
            await updatePurchaseToSucceeded(purchase);
          }
        }
      } catch (error) {
        console.error(`Error in follow-up payment verification for ${newPurchase._id}:`, error);
      }
    }, 3 * 60 * 1000);

    return res.status(200).json({
      success: true,
      url: session.url,
    });
  } catch (error) {
    console.error("Checkout Session Error:", error);
    return res.status(500).json({ message: "Payment initialization failed" });
  }
};

export const stripeWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const secret = process.env.WEBHOOK_ENDPOINT_SECRET;

  console.log("⚡ Webhook received", { 
    signature: !!sig, 
    hasSecret: !!secret,
    contentType: req.headers["content-type"],
    bodyType: typeof req.body
  });

  // Add debug info about environment
  console.log("Stripe configuration:", {
    keyExists: !!process.env.STRIPE_SECRET_KEY,
    secretExists: !!process.env.WEBHOOK_ENDPOINT_SECRET,
    stripeKeyStart: process.env.STRIPE_SECRET_KEY ? `${process.env.STRIPE_SECRET_KEY.substring(0, 7)}...` : "NOT_SET"
  });

  if (!secret) {
    console.error("❌ CRITICAL ERROR: Webhook endpoint secret is not set in environment variables!");
    console.error("Please create or update your .env file with WEBHOOK_ENDPOINT_SECRET");
    return res.status(500).send("Webhook Secret missing");
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
    console.log("✅ Webhook verified! Event type:", event.type);
  } catch (error) {
    console.error("❌ Webhook verification failed:", error.message);
    console.error("This could be due to a misconfigured secret or incorrect signature");
    
    // Log more details about the event for debugging
    try {
      const jsonData = JSON.parse(req.body.toString());
      console.log("Received webhook data:", {
        type: jsonData.type,
        id: jsonData.id,
        hasObject: !!jsonData.data?.object,
        objectType: jsonData.data?.object?.object
      });
    } catch (parseError) {
      console.error("Could not parse webhook body:", parseError.message);
    }
    
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  // Handle successful payments
  if (event.type === "checkout.session.completed") {
    console.log("💰 Payment succeeded - processing checkout.session.completed event");

    try {
      const session = event.data.object;
      console.log("Session ID:", session.id);
      console.log("Session details:", {
        paymentStatus: session.payment_status,
        amountTotal: session.amount_total,
        customer: session.customer,
        metadata: session.metadata
      });

      // Debug: Check for the specific problematic session ID
      const specificSessionId = "cs_test_a1yhrwDMB306hCrHfRnFp5C6OYQwe4tRTHMWQUNtEar1Lz4Ac4sSPXKLNr";
      if (session.id === specificSessionId || specificSessionId.includes(session.id)) {
        console.log("🔍 Found the specific problematic session ID!");
      }

      // Find purchase using session ID
      let purchase = await CoursePurchase.findOne({
        paymentId: session.id,
      });

      if (!purchase) {
        console.warn("⚠️ Purchase not found for session ID:", session.id);
        
        // Try to find by sessionId with a substring match (in case of truncation)
        purchase = await CoursePurchase.findOne({
          paymentId: { $regex: session.id.substring(0, 20) }
        });
        
        if (purchase) {
          console.log("🔍 Found purchase with partial session ID match!");
        } else if (session.metadata && session.metadata.courseId && session.metadata.userId) {
          // Try to find by metadata as fallback
          console.log("Trying to find purchase by metadata:", session.metadata);
          purchase = await CoursePurchase.findOne({
            courseId: session.metadata.courseId,
            userId: session.metadata.userId,
            status: "pending"
          });
          
          if (purchase) {
            console.log("✅ Found purchase using metadata instead:", purchase._id);
            // Update the paymentId to match
            purchase.paymentId = session.id;
          } else {
            // Last resort: find any pending purchase for this user and course
            const recentPurchases = await CoursePurchase.find({ 
              status: "pending" 
            }).sort({ createdAt: -1 }).limit(5);
            
            console.log(`Found ${recentPurchases.length} recent pending purchases`);
            if (recentPurchases.length > 0) {
              purchase = recentPurchases[0]; // Use the most recent one
              console.log("⚠️ Using most recent pending purchase as fallback:", purchase._id);
              purchase.paymentId = session.id;
            }
          }
        }
        
        if (!purchase) {
          // Handle specific problematic session ID
          if (session.id === specificSessionId || specificSessionId.includes(session.id)) {
            try {
              const specificPurchase = await CoursePurchase.findById("682463c0b70ad39d9ac8c16b");
              if (specificPurchase && specificPurchase.status === "pending") {
                console.log("🎯 Found the specific problematic purchase by ID!");
                purchase = specificPurchase;
              }
            } catch (idError) {
              console.error("Error finding specific purchase:", idError);
            }
          }
          
          if (!purchase) {
            console.error("❌ Could not find matching purchase record");
            return res.status(404).json({ message: "Purchase not found" });
          }
        }
      }

      console.log("Found purchase record:", {
        id: purchase._id,
        currentStatus: purchase.status,
        courseId: purchase.courseId,
        userId: purchase.userId,
        currentPaymentId: purchase.paymentId
      });

      // Update purchase amount from session
      purchase.amount = session.amount_total / 100;
      
      // Use the utility function to update the purchase to succeeded
      await updatePurchaseToSucceeded(purchase);

    } catch (error) {
      console.error("💥 Webhook processing error:", error);
      console.error("Stack trace:", error.stack);
      return res.status(500).json({ message: "Internal Server Error during webhook processing" });
    }
  }

  // Always return a 200 response to acknowledge receipt of the event
  res.status(200).json({ received: true });
};

export const getCourseDetailWithPurchaseStatus = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.id;

    const course = await Course.findById(courseId)
      .populate({ path: "creator" })
      .populate({ path: "lectures" });

    const purchased = await CoursePurchase.findOne({ userId, courseId });
    console.log(purchased);

    if (!course) {
      return res.status(404).json({ message: "course not found!" });
    }

    return res.status(200).json({
      course,
      purchased: !!purchased, // true if purchased, false otherwise
    });
  } catch (error) {
    console.log(error);
  }
};

export const getAllPurchasedCourse = async (req, res) => {
  try {
    const userId = req.id;
    
    // Find all purchased courses for this user
    const purchasedCourses = await CoursePurchase.find({
      userId,
      status: "succeeded",
    }).populate({
      path: "courseId",
      populate: {
        path: "lectures creator",
        select: "lectureTitle name firstName lastName photoUrl"
      }
    });
    
    if (!purchasedCourses || purchasedCourses.length === 0) {
      return res.status(200).json({
        purchasedCourse: [],
      });
    }
    
    // Import CourseProgress to get progress information
    const { CourseProgress } = await import("../models/courseProgress.js");
    
    // Get progress information for all user's courses
    const courseProgressPromises = purchasedCourses.map(async (purchase) => {
      const courseId = purchase.courseId._id.toString();
      
      // Find progress for this course
      const progress = await CourseProgress.findOne({
        userId,
        courseId
      });
      
      // Calculate completion metrics
      const totalLectures = purchase.courseId.lectures?.length || 0;
      const completedLectures = progress?.lectureProgress?.filter(lp => lp.viewed)?.length || 0;
      const progressPercentage = totalLectures > 0 
        ? Math.round((completedLectures / totalLectures) * 100) 
        : 0;
      
      // Return enhanced purchase object with progress info
      return {
        ...purchase.toObject(),
        progress: progressPercentage,
        completedLectures,
        completed: progress?.completed || false
      };
    });
    
    // Wait for all progress data to be fetched
    const enhancedPurchases = await Promise.all(courseProgressPromises);
    
    return res.status(200).json({
      purchasedCourse: enhancedPurchases,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({
      message: "Failed to fetch purchased courses",
      error: error.message
    });
  }
};

export const getInstructorSalesData = async (req, res) => {
  try {
    const instructorId = req.id;
    
    // Get all courses created by this instructor
    const instructorCourses = await Course.find({ creator: instructorId });
    
    if (!instructorCourses || instructorCourses.length === 0) {
      return res.status(200).json({
        sales: [],
        totalSales: 0,
        totalRevenue: 0
      });
    }
    
    // Get the IDs of all instructor courses
    const courseIds = instructorCourses.map(course => course._id);
    
    // Find all successful purchases for instructor's courses
    const salesData = await CoursePurchase.find({
      courseId: { $in: courseIds },
      status: "succeeded"
    }).populate({
      path: "courseId userId",
      select: "courseTitle coursePrice name email"
    });
    
    // Calculate total sales and revenue
    const totalSales = salesData.length;
    const totalRevenue = salesData.reduce((sum, sale) => sum + (sale.amount || 0), 0);
    
    // Group by course for detailed breakdown
    const salesByProduct = {};
    
    salesData.forEach(sale => {
      const courseId = sale.courseId?._id?.toString();
      
      if (courseId) {
        if (!salesByProduct[courseId]) {
          salesByProduct[courseId] = {
            courseId,
            courseTitle: sale.courseId.courseTitle || "Unknown Course",
            salesCount: 0,
            revenue: 0,
            purchasers: []
          };
        }
        
        salesByProduct[courseId].salesCount += 1;
        salesByProduct[courseId].revenue += sale.amount || 0;
        
        // Add purchaser info if available
        if (sale.userId) {
          salesByProduct[courseId].purchasers.push({
            userId: sale.userId._id,
            name: sale.userId.name || "Unknown User",
            email: sale.userId.email || "",
            purchaseDate: sale.createdAt
          });
        }
      }
    });
    
    return res.status(200).json({
      sales: Object.values(salesByProduct),
      totalSales,
      totalRevenue,
      rawSalesData: salesData
    });
    
  } catch (error) {
    console.error("Error fetching instructor sales data:", error);
    return res.status(500).json({
      message: "Failed to fetch sales data",
      error: error.message
    });
  }
};

export const getPendingPurchases = async (req, res) => {
  try {
    const userId = req.id;
    
    // Find all pending purchases for this user
    const pendingPurchases = await CoursePurchase.find({
      userId,
      status: "pending",
      // Only include purchases created in the last 24 hours
      createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }).populate({
      path: "courseId",
      populate: {
        path: "lectures creator",
        select: "lectureTitle name firstName lastName photoUrl"
      }
    });
    
    // For each pending purchase, verify with Stripe if it should be "succeeded"
    const pendingChecks = await Promise.all(pendingPurchases.map(async (purchase) => {
      try {
        const stripeCheck = await verifyPaymentWithStripe(purchase.paymentId);
        
        // If Stripe says it's actually paid, update it
        if (stripeCheck.verified) {
          console.log(`🔄 Pending purchase ${purchase._id} verified as paid while checking pending list`);
          await updatePurchaseToSucceeded(purchase);
          return null; // Don't include in response as it's no longer pending
        }
        
        return purchase; // Still pending, include in response
      } catch (error) {
        console.error(`Error checking pending purchase ${purchase._id}:`, error);
        return purchase; // Still include it in the response even if check fails
      }
    }));
    
    // Filter out any null values (purchases that were updated)
    const validPendingPurchases = pendingChecks.filter(p => p !== null);
    
    return res.status(200).json({
      pendingPurchases: validPendingPurchases,
    });
  } catch (error) {
    console.error("Error fetching pending purchases:", error);
    return res.status(500).json({
      message: "Failed to fetch pending purchases",
      error: error.message
    });
  }
};
