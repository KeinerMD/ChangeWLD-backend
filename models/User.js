// models/User.js
import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    nullifier: { type: String, unique: true, required: true }, // World ID
    walletAddress: { type: String }, // dirección en World Chain
  },
  { timestamps: true }
);

export const User = mongoose.model("User", userSchema);