import { program } from 'commander';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { CoursePurchase } from '../models/coursePurchase.model.js';
import { Course } from '../models/course.model.js';
import User from '../models/user.model.js';
import Stripe from 'stripe';

dotenv.config();

// Initialize database connection
async function connectDB() {
  try {
    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
}

// Initialize Stripe
const stripe = process.env.STRIPE_SECRET_KEY 
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

program
  .name('LMS Admin Tools')
  .description('Command-line utilities for LMS administrators')
  .version('1.0.0');

// List all payments command
program
  .command('list-payments')
  .description('List all payments with their statuses')
  .option('-s, --status <status>', 'Filter by payment status (pending, succeeded, failed)')
  .option('-d, --days <days>', 'Show payments from the last X days', parseInt)
  .option('-l, --limit <limit>', 'Limit the number of results', parseInt, 10)
  .action(async (options) => {
    await connectDB();
    try {
      let query = {};
      
      // Apply status filter if provided
      if (options.status) {
        query.status = options.status;
      }
      
      // Apply date filter if days provided
      if (options.days) {
        const daysAgo = new Date();
        daysAgo.setDate(daysAgo.getDate() - options.days);
        query.createdAt = { $gte: daysAgo };
      }
      
      // Execute query
      const payments = await CoursePurchase.find(query)
        .sort({ createdAt: -1 })
        .limit(options.limit)
        .populate({
          path: 'courseId',
          select: 'courseTitle',
        })
        .populate({
          path: 'userId',
          select: 'firstName lastName email',
        });
      
      console.log(`\n🔍 Found ${payments.length} payments\n`);
      
      if (payments.length === 0) {
        console.log('No payments match your criteria.');
      } else {
        // Display payments in a nice table format
        console.log('ID                        | Status    | Amount  | Course                   | User                     | Created At');
        console.log('-------------------------|-----------|---------|--------------------------|--------------------------|-------------------');
        
        payments.forEach(payment => {
          const id = payment._id.toString();
          const status = payment.status.padEnd(9);
          const amount = `₹${payment.amount}`.padEnd(7);
          const course = (payment.courseId?.courseTitle || 'Unknown').substring(0, 24).padEnd(24);
          const user = payment.userId 
            ? `${payment.userId.firstName || ''} ${payment.userId.lastName || ''}`.substring(0, 24).padEnd(24)
            : 'Unknown'.padEnd(24);
          const date = payment.createdAt.toISOString().split('T')[0];
          
          console.log(`${id} | ${status} | ${amount} | ${course} | ${user} | ${date}`);
        });
      }
    } catch (error) {
      console.error('❌ Error listing payments:', error);
    } finally {
      mongoose.connection.close();
    }
  });

// Fix pending payments command
program
  .command('fix-payments')
  .description('Fix stuck pending payments')
  .option('-i, --id <id>', 'Fix a specific payment by ID')
  .option('-a, --all', 'Fix all pending payments')
  .option('-f, --force', 'Force update even recent payments')
  .option('-h, --hours <hours>', 'Only fix payments older than X hours', parseInt, 1)
  .action(async (options) => {
    if (!options.id && !options.all) {
      console.error('❌ Error: You must specify either a payment ID (--id) or use --all flag');
      process.exit(1);
    }
    
    await connectDB();
    try {
      if (options.id) {
        // Fix a specific payment
        const payment = await CoursePurchase.findById(options.id);
        
        if (!payment) {
          console.error(`❌ Payment with ID ${options.id} not found`);
          process.exit(1);
        }
        
        await fixPayment(payment, options.force);
      } else if (options.all) {
        // Fix all pending payments
        console.log('🔍 Looking for pending payments...');
        
        const query = { status: 'pending' };
        
        // Add time filter unless forced
        if (!options.force) {
          const hoursAgo = new Date();
          hoursAgo.setHours(hoursAgo.getHours() - options.hours);
          query.createdAt = { $lt: hoursAgo };
          console.log(`⏱️  Only fixing payments older than ${options.hours} hour(s)`);
        }
        
        const pendingPayments = await CoursePurchase.find(query).populate('courseId');
        
        if (pendingPayments.length === 0) {
          console.log('✅ No pending payments found that match your criteria');
          process.exit(0);
        }
        
        console.log(`Found ${pendingPayments.length} pending payments to fix`);
        
        let fixed = 0;
        let errors = 0;
        
        for (const payment of pendingPayments) {
          try {
            const success = await fixPayment(payment, options.force);
            if (success) fixed++;
          } catch (error) {
            console.error(`❌ Error fixing payment ${payment._id}:`, error);
            errors++;
          }
        }
        
        console.log(`\n📊 Summary: Fixed ${fixed}/${pendingPayments.length} payments (${errors} errors)`);
      }
    } catch (error) {
      console.error('❌ Error fixing payments:', error);
    } finally {
      mongoose.connection.close();
    }
  });

// Helper function to fix a single payment
async function fixPayment(payment, force = false) {
  console.log(`\n📦 Processing payment: ${payment._id}`);
  console.log('Payment details:', {
    courseId: payment.courseId?._id || payment.courseId,
    status: payment.status,
    amount: payment.amount,
    createdAt: payment.createdAt,
    paymentId: payment.paymentId
  });
  
  if (payment.status !== 'pending') {
    console.log(`⚠️ Payment is already in ${payment.status} status. No action needed.`);
    return false;
  }
  
  // Check with Stripe if possible
  let stripeVerified = false;
  if (stripe && payment.paymentId && payment.paymentId.startsWith('cs_')) {
    try {
      console.log('🔍 Checking payment status with Stripe...');
      const session = await stripe.checkout.sessions.retrieve(payment.paymentId);
      console.log(`Stripe status: ${session.payment_status}`);
      
      if (session.payment_status === 'paid') {
        console.log('✅ Stripe confirms this payment is PAID');
        stripeVerified = true;
      }
    } catch (error) {
      console.log(`❌ Stripe verification failed: ${error.message}`);
    }
  }
  
  // Fix if forced or verified with Stripe
  if (force || stripeVerified) {
    console.log(`💾 Updating payment status to "succeeded"`);
    payment.status = 'succeeded';
    await payment.save();
    
    try {
      // Make sure we have the populated courseId
      if (!payment.courseId._id) {
        await payment.populate('courseId');
      }
      
      // Update user enrollments
      console.log('📝 Updating user enrollments...');
      await User.findByIdAndUpdate(
        payment.userId,
        { $addToSet: { enrolledCourses: payment.courseId._id } }
      );
      
      // Update course enrollments
      console.log('📝 Updating course enrollments...');
      await Course.findByIdAndUpdate(
        payment.courseId._id,
        { $addToSet: { enrolledStudents: payment.userId } }
      );
      
      console.log(`✅ Successfully fixed payment ${payment._id}`);
      return true;
    } catch (error) {
      console.error('❌ Error updating enrollments:', error);
      return false;
    }
  } else {
    console.log('⏳ Payment not updated - not verified by Stripe and force not enabled');
    return false;
  }
}

// Parse command line arguments
program.parse();

// Show help if no arguments provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
} 