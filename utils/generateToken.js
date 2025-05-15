import jwt from "jsonwebtoken";

export const generateToken = (res, user, message) => {
  const token = jwt.sign({ userId: user._id }, process.env.SECRET_KEY, {
    expiresIn: "1d",
  });

  // Set cookie with safe cross-domain settings
  res.cookie("token", token, {
    httpOnly: true,
    secure: true, // Ensure cookie is sent over HTTPS only
    sameSite: "none", // Allow cross-site cookie
    maxAge: 24 * 60 * 60 * 1000 // 1 day
  });

  // Also include token directly in the response for direct client-side access
  return res
    .status(200)
    .json({
        success: true,
        message,
        user,
        token // Send token in response body too
    });
};