import User from "../models/user.model.js";

const isInstructor = async (req, res, next) => {
  try {
    // Get the user ID from the isAuthenticated middleware
    const userId = req.id;
    
    if (!userId) {
      return res.status(401).json({
        message: "Authentication required."
      });
    }
    
    // Find the user and check if they are an instructor
    const user = await User.findById(userId);
    
    if (!user) {
      return res.status(404).json({
        message: "User not found."
      });
    }
    
    if (user.role !== "instructor") {
      return res.status(403).json({
        message: "Access denied. Instructor role required."
      });
    }
    
    // User is an instructor, proceed to next middleware
    next();
    
  } catch (error) {
    console.error("isInstructor middleware error:", error);
    return res.status(500).json({
      message: "Server error checking instructor status."
    });
  }
};

export default isInstructor; 