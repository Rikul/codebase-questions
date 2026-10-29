import os
from celery import Celery

app = Celery('tasks', broker=os.environ.get('REDIS_URL', 'redis://localhost:6379/0'))


@app.task
def send_welcome_email(user_id):
    """Send a welcome email to a newly created user."""
    return user_id
