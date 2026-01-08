const errorHandler = (err, req, res, next) => {
    console.error('An error occurred:', err);

    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal Server Error';

    res.status(statusCode).json({
        error: message,
        // stack: process.env.NODE_ENV === 'production' ? undefined : err.stack, // Optional: useful for debugging
    });
};

module.exports = errorHandler;
