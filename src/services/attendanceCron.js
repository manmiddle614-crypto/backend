import cron from 'node-cron';
import Attendance from '../models/Attendance.js';
import { Customer } from '../models/Customer.js';

// Run daily at 5:00 AM
export const startAttendanceCron = () => {
  cron.schedule('0 5 * * *', async () => {

    try {
      const today = Attendance.getDateOnly();
      
      // Get all active customers
      const customers = await Customer.find({ 
        active: true
      }).select('_id messId').lean();

      if (!customers.length) {

        return;
      }

      // Prepare bulk insert
      const attendanceRecords = customers.map(customer => ({
        messId: customer.messId,
        customerId: customer._id,
        date: today,
        status: 'PENDING',
        mealTypes: []
      }));

      // Bulk insert with ordered: false to skip duplicates
      const result = await Attendance.insertMany(attendanceRecords, { 
        ordered: false,
        rawResult: true 
      }).catch(err => {
        // Ignore duplicate key errors
        if (err.code === 11000) {
          return { insertedCount: err.result?.nInserted || 0 };
        }
        throw err;
      });

    } catch (error) {

    }
  });

};

// Manual trigger for testing
export const generateTodayAttendance = async () => {
  const today = Attendance.getDateOnly();
  
  const customers = await Customer.find({ 
    active: true
  }).select('_id messId').lean();

  const records = customers.map(c => ({
    messId: c.messId,
    customerId: c._id,
    date: today,
    status: 'PENDING'
  }));

  const result = await Attendance.insertMany(records, { 
    ordered: false 
  }).catch(err => {
    if (err.code === 11000) return { insertedCount: 0 };
    throw err;
  });

  return result.insertedCount || 0;
};
