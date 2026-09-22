const mongoose = require("mongoose");
const { requireEnv } = require("./env");

const connectDB = async () => {
    const [uri] = requireEnv("MONGODB_URI"); // kept in Backend/.env, never in the code
    await mongoose.connect(uri);
}

// connectDB().then(() => {
//     console.log("database connection established..")
// }).catch((err) => {
//     console.error("connection failed", err)
// }) // this part is done in app.js


//export 
module.exports = connectDB;