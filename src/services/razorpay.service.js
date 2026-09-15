const Razorpay = require('razorpay');
const crypto = require('crypto');

// Lazy-init: don't crash the whole server at boot just because Razorpay
// keys aren't filled in yet — only fail when a payment is actually attempted,
// with a clear error, so the rest of the app (auth, search, KYC, etc.) keeps
// working even before you've set up Razorpay.
let instance = null;
function getInstance() {
  if (instance) return instance;
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw Object.assign(new Error('Razorpay is not configured (RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET missing in .env)'), { status: 503 });
  }
  instance = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
  return instance;
}

async function createOrder(amountInRupees, receipt) {
  const order = await getInstance().orders.create({
    amount: Math.round(amountInRupees * 100), // paise
    currency: 'INR',
    receipt,
    payment_capture: 1,
  });
  return order;
}

function verifySignature({ order_id, payment_id, signature }) {
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${order_id}|${payment_id}`)
    .digest('hex');
  return expected === signature;
}

/**
 * Cancellation policy: 75% refund of the amount actually paid for the seat.
 */
async function refundBooking(paymentId, paidAmountRupees) {
  const refundAmount = Math.round(paidAmountRupees * 0.75 * 100); // paise, 75%
  const refund = await getInstance().payments.refund(paymentId, {
    amount: refundAmount,
  });
  return { refund, refundAmountRupees: refundAmount / 100 };
}

module.exports = { createOrder, verifySignature, refundBooking };

//	4386 2894 0766 0153, demo key