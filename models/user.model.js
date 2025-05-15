import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  firstName: {
    type: String,
    required: true,
    trim: true
  },
  lastName: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  phoneCode: {
    type: String,
    required: true,
    default: '+91' 
  },
  phoneNumber: {
    type: String,
    required: true
  },
    role: {
      type: String,
      enum: ['student', 'instructor'],
      default: 'user'
  },
  country: {
    type: String,
    required: true,
    default: 'India'
  },
  state: {
    type: String,
    required: true
  },
  city: {
    type: String,
    required: true
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other'],
    required: true
  },
  enrolledCourses: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Course'
    }
  ],
  photoUrl:{
    type:String,
    default:""
}
}, {
  timestamps: true
});

export default mongoose.model('User', userSchema);
