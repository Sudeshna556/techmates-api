require("./config/env").requireEnv("MONGODB_URI", "JWT_SECRET"); // load Backend/.env before anything else
const express = require("express");
const { UPLOAD_DIR } = require("./utils/uploads");
const connectDB = require("./config/db")
const app = express();
const cookieParser = require("cookie-parser")
const cors = require("cors")

const allowedOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    ...(process.env.CLIENT_URL ? process.env.CLIENT_URL.split(",").map((o) => o.trim()) : []),
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
}));
app.use(express.json()); // middleware to parse the incoming request body to js object
app.use(cookieParser())

// serve uploaded profile photos (file names are unique, so they can be cached)
app.use("/uploads", express.static(UPLOAD_DIR, {
    maxAge: "7d",
    setHeaders: (res) => res.setHeader("X-Content-Type-Options", "nosniff"),
}));

//manage all the routes by using the router
//1. import all the routes
const authRouter = require("./routes/authRoutes");
const profileRouter = require("./routes/profileRoutes");
const requestRouter = require("./routes/followRequest");
const userRouter = require("./routes/userRouter");
const postRouter = require("./routes/postRoutes");
const projectRouter = require("./routes/projectRoutes");
const chatRouter = require("./routes/chatRoutes");
const { startBlobSweeper } = require("./utils/blobSweeper");
//2. use the router and mount the routes

app.use("/", authRouter);
app.use("/", profileRouter);
app.use("/", requestRouter);
app.use("/", userRouter);
app.use("/", postRouter);
app.use("/", projectRouter);
app.use("/", chatRouter);


connectDB().then(() => {
    console.log("database connection established..")
    startBlobSweeper(require("./routes/projectCommon").isBlobUsed) // tidies up project files nobody needs any more
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`server is running on port ${PORT}`)
    })
}).catch((err) => {
    console.error("connection failed", err)
    // Optionally exit the process if the DB connection is critical
    // process.exit(1); 
})



