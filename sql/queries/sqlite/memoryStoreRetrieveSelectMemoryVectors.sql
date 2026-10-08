select memory_id as id from memory_vectors
         where embedding match ? and k = ? order by distance
