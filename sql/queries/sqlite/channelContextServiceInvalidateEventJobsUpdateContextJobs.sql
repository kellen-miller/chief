update context_jobs
         set status = 'failed', lease_expires_at = null,
             last_error_category = 'source-invalidated'
         where tier = 'hourly' and timezone = ?
           and period_start = ? and period_end = ?
           {{0}}
