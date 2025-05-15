import jwt from "jsonwebtoken";

const isAuthenticated = async (req, res, next) => {
    try {
        // Try to get token from cookie or Authorization header
        let token = req.cookies?.token;
        
        // If no token in cookie, check Authorization header
        if (!token) {
            const authHeader = req.headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                token = authHeader.split(' ')[1];
            }
        }
        
        if (!token) {
            return res.status(401).json({
                message: 'You are not authenticated',
                success: false
            });
        }
        
        const decode = jwt.verify(token, process.env.SECRET_KEY);
        if(!decode) {
            return res.status(401).json({
                message: "Invalid token",
                success: false
            });
        }
        
        req.id = decode.userId;
        next();
    } catch (error) {
        console.log("Token verification failed:", error.message);
        return res.status(401).json({
            message: "Authentication failed",
            success: false
        });
    }
};

export default isAuthenticated;
