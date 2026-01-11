import express from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/User.js";
import { ApiError } from "../utils/errorHandler.js";
import { successResponse } from "../utils/response.js";

const router = express.Router();

const registerHandler = async (req, res, next) => {
  try {
    const { name, email, phone, password, role } = req.body;

    if (!name || !email || !password) {
      throw new ApiError("Missing required fields", 400, "VALIDATION_ERROR");
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      throw new ApiError("Email already exists", 409, "DUPLICATE_EMAIL");
    }

    const user = new User({
      name,
      email,
      phone,
      role: role || "staff",
      passwordHash: password,
    });

    await user.save();

    res.status(201).json(
      successResponse(
        {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
        "User registered successfully",
      ),
    );
  } catch (err) {
    next(err);
  }
};

const loginHandler = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new ApiError("Email and password required", 400, "VALIDATION_ERROR");
    }

    const user = await User.findOne({ email: email.toLowerCase() })
      .select('_id name email role passwordHash messId active')
      .lean();

    if (!user) {
      throw new ApiError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    if (!user.active) {
      throw new ApiError("Account is inactive", 401, "ACCOUNT_INACTIVE");
    }

    // Need to create User instance for password comparison
    const userInstance = await User.findById(user._id);
    const isPasswordValid = await userInstance.comparePassword(password);

    if (!isPasswordValid) {
      throw new ApiError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    const token = jwt.sign(
      {
        sub: user._id,
        id: user._id,
        email: user.email,
        role: user.role,
        name: user.name,
        messId: user.messId
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }, // 🔒 BLOCKER 4: Reduced from 7d to 24h
    );

    res.json(
      successResponse(
        { 
          token, 
          user: { 
            id: user._id, 
            name: user.name, 
            email: user.email, 
            role: user.role,
            messId: user.messId
          } 
        },
        "Login successful",
      ),
    );
  } catch (err) {

    next(err);
  }
};

router.post("/register", registerHandler);
router.post("/login", loginHandler);

export default router;