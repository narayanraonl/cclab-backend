// jshint esversion:6

import express from "express";
import mongoose from "mongoose";
import bodyParser from "body-parser";
import methodOverride from "method-override";
import multer from "multer";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import multerS3 from "multer-s3";

dotenv.config();

mongoose.set('strictQuery', true);
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("Connected to MongoDB")).catch(console.error);

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cors());
app.use(express.static("public"));

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const upload = multer({
  storage: multerS3({
    s3: s3Client,
    bucket: process.env.S3_BUCKET_NAME,
    key: (req, file, cb) => {
      cb(null, `Images/${file.fieldname}_${Date.now()}${path.extname(file.originalname)}`);
    }
  })
});

const postSchema = {
  title: String,
  content: String,
  imageKey: String // Store only the S3 key for the image
};

const Post = mongoose.model("Post", postSchema);

app.get('/', async (req, res) => {
  try {
    const posts = await Post.find({});

    const postsWithUrls = await Promise.all(posts.map(async (post) => {
      try {
        const signedUrl = await getSignedUrl(
          s3Client,
          new GetObjectCommand({
            Bucket: process.env.S3_BUCKET_NAME,
            Key: post.imageKey,
            ResponseContentType: 'image/jpeg'
          }),
          { expiresIn: 3600 }
        );
        return { ...post.toObject(), imageUrl: signedUrl };
      } catch (err) {
        console.error(`Error generating signed URL for ${post.imageKey}`, err);
        return { ...post.toObject(), imageUrl: null }; // Return null if there's an error
      }
    }));

    res.status(200).json(postsWithUrls);
  } catch (err) {
    console.error("Error fetching posts", err);
    res.status(500).send("Error fetching posts");
  }
});

app.post('/compose', upload.single('file'), async (req, res) => {
  try {
    const post = new Post({
      title: req.body.postTitle,
      content: req.body.postContent,
      imageKey: req.file.key // Store only the S3 key (path within the bucket)
    });

    await post.save();
    res.status(201).json(post);
  } catch (err) {
    console.error("Error saving post", err);
    res.status(500).send("Error saving post");
  }
});

app.get('/posts/:postID', async (req, res) => {
  const postID = req.params.postID;
  try {
    const foundPost = await Post.findOne({ _id: postID });
    if (!foundPost) {
      return res.status(404).send("Post not found");
    }

    const signedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME,
        Key: foundPost.imageKey
      }),
      { expiresIn: 3600 }
    );

    res.status(200).json({ ...foundPost.toObject(), imageUrl: signedUrl });
  } catch (err) {
    console.error(`Error fetching post with ID ${postID}`, err);
    res.status(500).send("Error fetching post");
  }
});

app.delete('/posts/:postID', async (req, res) => {
  const postID = req.params.postID;
  try {
    const post = await Post.findById(postID);
    if (!post) {
      return res.status(404).send("Post not found");
    }

    // Delete image from S3
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.S3_BUCKET_NAME,
      Key: post.imageKey // Use the stored S3 key to delete the object
    }));

    // Delete post from database
    await Post.deleteOne({ _id: postID });
    res.status(200).send("Post and image deleted");
  } catch (err) {
    console.error(`Error deleting post with ID ${postID}`, err);
    res.status(500).send("Error deleting post");
  }
});

app.use(methodOverride('_method'));

app.listen(process.env.PORT || 3001, () => console.log(`Server running on ${process.env.PORT || 3001}`));
