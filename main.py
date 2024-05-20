from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from mangum import Mangum
import boto3
import json
import uuid

app = FastAPI()

s3_client = boto3.client('s3')
PENDING_BUCKET = 'movies-stage'
FINAL_BUCKET = 'movies-final'

class Movie(BaseModel):
    title: str
    year: int
    genre: str

@app.post("/movies/")
async def submit_movie(movie: Movie):
    movie_id = str(uuid.uuid4())
    movie_data = movie.dict()
    s3_client.put_object(Bucket=PENDING_BUCKET, Key=f'{movie_id}.json', Body=json.dumps(movie_data))
    return {"message": "Movie submitted for approval.", "movie_id": movie_id}

@app.get("/movies/")
async def get_movies():
    response = s3_client.list_objects_v2(Bucket=FINAL_BUCKET)
    movies = []
    if 'Contents' in response:
        for obj in response['Contents']:
            movie_data = s3_client.get_object(Bucket=FINAL_BUCKET, Key=obj['Key'])
            movies.append(json.loads(movie_data['Body'].read().decode('utf-8')))
    return movies

@app.post("/approve_movie/{movie_id}")
async def approve_movie(movie_id: str):
    try:
        movie_data = s3_client.get_object(Bucket=PENDING_BUCKET, Key=f'{movie_id}.json')
        s3_client.put_object(Bucket=FINAL_BUCKET, Key=f'{movie_id}.json', Body=movie_data['Body'].read())
        s3_client.delete_object(Bucket=PENDING_BUCKET, Key=f'{movie_id}.json')
        return {"message": "Movie approved and moved to final bucket."}
    except Exception as e:
        raise HTTPException(status_code=400, detail="Movie not found or already approved.")

handler = Mangum(app)
