# TechMates API Lists

## authenticate User or authRouter
POST/signup
POST/login
POST/logout

## profileRouter
GET/profile/view
PATCH/profile/edit
PATCH/profile/update-password

## connectionRequestRouter
POST/request/send/interested/:userId
POST/request/send/ignored/:userId

## connectionReviewRouter
POST/request/review/accept/:userId
POST/request/review/reject/:userId

## connectionRouter
GET/connections/view
GET/requests/received
GET/requests/sent
GET/feed


status : accepted,interested,ignored,rejected




